package in.mitticloud.app;

import android.app.Activity;
import android.content.Intent;
import android.app.DownloadManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;

/**
 * Starts the foreground service, copies the bundled server out of the APK on
 * first run, and shows the dashboard from localhost:7333 in a WebView.
 */
public class MainActivity extends Activity {
    private static final String URL = "http://localhost:7333/";
    private static final String VERSION = "0.17.26";
    private static final int FILE_REQUEST = 4101;
    private static final int FOLDER_REQUEST = 4102;
    private static final int PHOTOS_REQUEST = 4103;
    private static final int FILES_REQUEST = 4104;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Uri folderTree;
    private final List<Entry> folderEntries = new ArrayList<>();
    private String pendingFilesDir = "";
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF000000);

        TextView title = new TextView(this);
        title.setText("MittiCloud");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(28);
        title.setPadding(48, 96, 48, 24);
        root.addView(title);

        Button start = new Button(this);
        start.setText("Start MittiCloud 24/7");
        start.setOnClickListener(v -> startCloud());
        root.addView(start);

        Button battery = new Button(this);
        battery.setText("Keep it awake: allow unrestricted battery");
        battery.setOnClickListener(v -> requestBatteryExemption());
        root.addView(battery);

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        // Lets a computer diagnose page-side failures (uploads, console
        // errors) over adb while the dashboard runs in this WebView.
        WebView.setWebContentsDebuggingEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = params.createIntent();
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(pick, FILE_REQUEST);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            req.addRequestHeader("User-Agent", userAgent);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                    URLUtil.guessFileName(url, contentDisposition, mimeType));
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
            Toast.makeText(this, "Downloading to Downloads", Toast.LENGTH_SHORT).show();
        });
        // The dashboard calls these when the phone itself must pick a folder
        // (Android's WebView cannot do directory picks) and when it is time to
        // stream that folder into a site or an app.
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void pickFolder() {
                handler.post(MainActivity.this::startFolderPick);
            }

            @android.webkit.JavascriptInterface
            public void uploadPicked(final String target, final String name) {
                new Thread(() -> uploadTree(target, name)).start();
            }

            @android.webkit.JavascriptInterface
            public void pickPhotos() {
                handler.post(MainActivity.this::startPhotoPick);
            }

            @android.webkit.JavascriptInterface
            public void pickFiles(final String dir) {
                pendingFilesDir = dir == null ? "" : dir;
                handler.post(MainActivity.this::startFilePick);
            }
        }, "MittiCloud");
        root.addView(web, new LinearLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Android recreates this activity under memory pressure (old phone,
        // big picker screens), which leaves a blank WebView on the Start
        // buttons even though the cloud is already running. When the server
        // answers and this WebView holds no page yet, go straight back to
        // the dashboard. A WebView that already has a page is left alone —
        // reloading here would destroy an upload that is in flight when the
        // user returns from the file picker.
        new Thread(() -> {
            boolean up = false;
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(URL).openConnection();
                c.setConnectTimeout(800);
                c.setReadTimeout(800);
                up = c.getResponseCode() > 0;
                c.disconnect();
            } catch (Exception ignored) {
            }
            final boolean ready = up;
            handler.post(() -> {
                if (ready && web.getUrl() == null) web.loadUrl(URL);
            });
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PHOTOS_REQUEST || requestCode == FILES_REQUEST) {
            List<Uri> uris = new ArrayList<>();
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                        uris.add(data.getClipData().getItemAt(i).getUri());
                    }
                } else if (data.getData() != null) {
                    uris.add(data.getData());
                }
            }
            if (uris.isEmpty()) {
                callJs(requestCode == PHOTOS_REQUEST ? "onNativePhotosDone" : "onNativeFilesDone",
                        q("{\"ok\":false,\"error\":\"Nothing chosen\"}"));
                return;
            }
            final List<Uri> chosen = uris;
            final boolean photos = requestCode == PHOTOS_REQUEST;
            final String dir = pendingFilesDir;
            new Thread(() -> {
                if (photos) uploadPhotos(chosen);
                else uploadFiles(chosen, dir);
            }).start();
            return;
        }
        if (requestCode == FOLDER_REQUEST) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                folderTree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(folderTree,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {
                }
                new Thread(this::reportFolder).start();
            } else {
                callJs("onNativeFolderPicked", q("{\"error\":\"No folder chosen\",\"files\":[]}"));
            }
            return;
        }
        if (requestCode != FILE_REQUEST) return;
        if (fileCallback == null) {
            // The activity was recreated while the picker was open, so the
            // page that asked for files is gone — nothing to hand them to.
            // Say so instead of failing silently, which is what made
            // "upload does nothing" impossible to diagnose.
            android.util.Log.w("MittiCloud", "picker result arrived after recreation; dropping");
            Toast.makeText(this, "Android restarted the app while you were choosing — tap upload and pick again", Toast.LENGTH_LONG).show();
            return;
        }
        Uri[] picked = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    private void startCloud() {
        try {
            extractServerIfNeeded();
        } catch (Exception e) {
            web.loadData("Could not prepare MittiCloud: " + e.getMessage(), "text/plain", "utf-8");
            return;
        }
        Intent svc = new Intent(this, CloudService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
        else startService(svc);
        waitForServer(0);
    }

    /** Load the dashboard once the server answers, retrying for about 30 seconds. */
    private void waitForServer(int attempt) {
        new Thread(() -> {
            boolean up = false;
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(URL).openConnection();
                c.setConnectTimeout(1000);
                c.setReadTimeout(1000);
                up = c.getResponseCode() > 0;
                c.disconnect();
            } catch (Exception ignored) {
            }
            final boolean ready = up;
            handler.post(() -> {
                if (ready) {
                    web.loadUrl(URL);
                } else if (attempt < 30) {
                    web.loadData("<body style='background:#000;color:#fff;font-family:sans-serif;padding:24px'>Starting your cloud… (" + (attempt + 1) + "/30)</body>", "text/html", "utf-8");
                    handler.postDelayed(() -> waitForServer(attempt + 1), 1000);
                } else {
                    web.loadData("<body style='background:#000;color:#fff;font-family:sans-serif;padding:24px'>MittiCloud did not start. Tap Start MittiCloud 24/7 to try again.</body>", "text/html", "utf-8");
                }
            });
        }).start();
    }

    private void requestBatteryExemption() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        i.setData(Uri.parse("package:" + getPackageName()));
        startActivity(i);
    }

    /** Copy the bundled server (assets/mitti) into app storage once per version. */
    private void extractServerIfNeeded() throws Exception {
        File root = new File(getFilesDir(), "mitti");
        File marker = new File(root, ".version-" + VERSION);
        if (marker.exists()) return;
        copyAssetTree("mitti", root);
        marker.createNewFile();
    }

    private void copyAssetTree(String assetPath, File dest) throws Exception {
        String[] children = getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyFile(assetPath, dest);
            return;
        }
        dest.mkdirs();
        for (String c : children) copyAssetTree(assetPath + "/" + c, new File(dest, c));
    }

    private void copyFile(String assetPath, File dest) throws Exception {
        dest.getParentFile().mkdirs();
        try (InputStream in = getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    // --- native folder pick + streaming upload (the dashboard's folder flow) ---

    private void startOpenPick(int request, String[] mimes) {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.setType(mimes[0]);
        pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(pick, request);
        } catch (Exception e) {
            callJs(request == PHOTOS_REQUEST ? "onNativePhotosDone" : "onNativeFilesDone",
                    q("{\"ok\":false,\"error\":\"This phone has no file picker\"}"));
        }
    }

    private void startPhotoPick() {
        startOpenPick(PHOTOS_REQUEST, new String[]{"image/*", "video/*"});
    }

    private void startFilePick() {
        startOpenPick(FILES_REQUEST, new String[]{"*/*"});
    }

    private String nameOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToNext()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
        }
        return "file";
    }

    /** Stream chosen photos as multipart "photos" parts to the vault. */
    private void uploadPhotos(List<Uri> uris) {
        postMultipart("http://127.0.0.1:7333/api/photos/upload", uris, null, "photos", null,
                "onNativePhotosDone");
    }

    /** One multipart request per file (the files route takes a single part). */
    private void uploadFiles(List<Uri> uris, String dir) {
        int ok = 0;
        int failed = 0;
        String firstError = "";
        for (int i = 0; i < uris.size(); i++) {
            String name = nameOf(uris.get(i));
            String err = postMultipart("http://127.0.0.1:7333/api/files/upload-multipart",
                    uris.subList(i, i + 1), dir, "file", name, null);
            if (err == null) ok++;
            else {
                failed++;
                if (firstError.isEmpty()) firstError = err;
            }
            callJs("onNativeFilesProgress", q("{\"done\":" + (i + 1) + ",\"total\":" + uris.size() + "}"));
        }
        callJs("onNativeFilesDone", q("{\"ok\":" + (failed == 0) + ",\"done\":" + ok
                + ",\"failed\":" + failed + ",\"firstError\":" + q(firstError) + "}"));
    }

    /**
     * Stream the given URIs as multipart parts. Returns null on success, else
     * a plain-words error; when callback is set the server's JSON body (or the
     * error JSON) is handed to the dashboard instead.
     */
    private String postMultipart(String url, List<Uri> uris, String dirField, String fileField,
                                 String forcedName, String callback) {
        HttpURLConnection conn = null;
        try {
            String boundary = "MittiBoundary" + System.nanoTime();
            conn = (HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setChunkedStreamingMode(256 * 1024);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(0);
            OutputStream raw = new BufferedOutputStream(conn.getOutputStream());
            if (dirField != null) {
                writeAscii(raw, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"to\"\r\n\r\n"
                        + dirField + "\r\n");
            }
            for (Uri uri : uris) {
                String name = forcedName != null ? forcedName : nameOf(uri);
                if (dirField != null) {
                    writeAscii(raw, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"rel\"\r\n\r\n"
                            + name + "\r\n");
                }
                writeAscii(raw, "--" + boundary + "\r\nContent-Disposition: form-data; name="
                        + q(fileField) + "; filename=" + q(name)
                        + "\r\nContent-Type: application/octet-stream\r\n\r\n");
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while (in != null && (n = in.read(buf)) > 0) raw.write(buf, 0, n);
                }
                writeAscii(raw, "\r\n");
            }
            writeAscii(raw, "--" + boundary + "--\r\n");
            raw.flush();
            raw.close();
            int code = conn.getResponseCode();
            InputStream res = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder body = new StringBuilder();
            if (res != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = res.read(buf)) > 0) body.append(new String(buf, 0, n, "UTF-8"));
            }
            if (code >= 400) {
                String err = "Server said " + code;
                if (callback != null) {
                    callJs(callback, q("{\"ok\":false,\"error\":\"" + err + "\"}"));
                }
                return err;
            }
            if (callback != null) callJs(callback, q(body.toString()));
            return null;
        } catch (Exception ex) {
            String err = String.valueOf(ex.getMessage()).replace('"', '\'').replace('\n', ' ');
            if (callback != null) callJs(callback, q("{\"ok\":false,\"error\":\"" + err + "\"}"));
            return err;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void startFolderPick() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(pick, FOLDER_REQUEST);
        } catch (Exception e) {
            callJs("onNativeFolderPicked", q("{\"error\":\"This phone has no folder picker\",\"files\":[]}"));
        }
    }

    /** Walk the picked tree and hand the dashboard the file list. */
    private void reportFolder() {
        List<Entry> out = new ArrayList<>();
        try {
            String rootId = DocumentsContract.getTreeDocumentId(folderTree);
            String rootName = displayName(DocumentsContract.buildDocumentUriUsingTree(folderTree, rootId));
            walk(DocumentsContract.buildChildDocumentsUriUsingTree(folderTree, rootId),
                    rootName == null ? "project" : rootName, out);
        } catch (Exception e) {
            android.util.Log.w("MittiCloud", "folder walk failed", e);
        }
        folderEntries.clear();
        folderEntries.addAll(out);
        StringBuilder sb = new StringBuilder("{\"files\":[");
        for (int i = 0; i < out.size(); i++) {
            Entry e = out.get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"path\":").append(q(e.rel)).append(",\"size\":").append(e.size).append('}');
        }
        sb.append("]}");
        callJs("onNativeFolderPicked", q(sb.toString()));
    }

    private String displayName(Uri doc) {
        try (Cursor c = getContentResolver().query(doc,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToNext()) return c.getString(0);
        } catch (Exception ignored) {
        }
        return null;
    }

    private void walk(Uri children, String prefix, List<Entry> out) {
        if (out.size() >= 5000) return;
        try (Cursor c = getContentResolver().query(children, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE}, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.isNull(3) ? 0 : c.getLong(3);
                String rel = prefix + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(DocumentsContract.buildChildDocumentsUriUsingTree(folderTree, id), rel, out);
                } else {
                    Entry e = new Entry();
                    e.uri = DocumentsContract.buildDocumentUriUsingTree(folderTree, id);
                    e.rel = rel;
                    e.name = name;
                    e.size = size;
                    out.add(e);
                }
            }
        } catch (Exception e) {
            android.util.Log.w("MittiCloud", "walk failed at " + prefix, e);
        }
    }

    /** Stream the picked tree as multipart parts (field name = target path). */
    private void uploadTree(String target, String name) {
        List<Entry> entries = new ArrayList<>(folderEntries);
        if (entries.isEmpty()) {
            callJs("onNativeUploadDone", q("{\"ok\":false,\"error\":\"Pick a folder first\"}"));
            return;
        }
        String url = "http://127.0.0.1:7333/api/" + ("apps".equals(target) ? "apps/" : "sites/")
                + name + "/upload";
        HttpURLConnection conn = null;
        try {
            String boundary = "MittiBoundary" + System.nanoTime();
            conn = (HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setChunkedStreamingMode(256 * 1024);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(0); // big LAN uploads must not time out mid-stream
            OutputStream raw = new BufferedOutputStream(conn.getOutputStream());
            int doneCount = 0;
            for (Entry e : entries) {
                // reportFolder prefixes every path with the picked folder's own
                // name ("mysite/css/a.css"), which the dashboard strips for
                // display. The server writes the field name verbatim, so strip
                // that same top segment here — the picked folder IS the root.
                String rel = e.rel;
                int slash = rel.indexOf('/');
                if (slash >= 0) rel = rel.substring(slash + 1);
                writeAscii(raw, "--" + boundary + "\r\nContent-Disposition: form-data; name="
                        + q(rel) + "; filename=" + q(e.name)
                        + "\r\nContent-Type: application/octet-stream\r\n\r\n");
                try (InputStream in = getContentResolver().openInputStream(e.uri)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while (in != null && (n = in.read(buf)) > 0) raw.write(buf, 0, n);
                }
                writeAscii(raw, "\r\n");
                doneCount++;
                final int d = doneCount;
                final int t = entries.size();
                callJs("onNativeUploadProgress", q("{\"done\":" + d + ",\"total\":" + t + "}"));
            }
            writeAscii(raw, "--" + boundary + "--\r\n");
            raw.flush();
            raw.close();
            int code = conn.getResponseCode();
            InputStream res = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder body = new StringBuilder();
            if (res != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = res.read(buf)) > 0) body.append(new String(buf, 0, n, "UTF-8"));
            }
            if (code >= 400) {
                callJs("onNativeUploadDone", q("{\"ok\":false,\"error\":\"Server said " + code + ": "
                        + body.toString().replace('"', '\'') + "\"}"));
            } else {
                callJs("onNativeUploadDone", q(body.toString()));
            }
        } catch (Exception ex) {
            callJs("onNativeUploadDone", q("{\"ok\":false,\"error\":\""
                    + String.valueOf(ex.getMessage()).replace('"', '\'').replace('\n', ' ') + "\"}"));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void writeAscii(OutputStream out, String s) throws java.io.IOException {
        out.write(s.getBytes("UTF-8"));
    }

    /** Evaluate a dashboard callback with one JSON-string argument. */
    private void callJs(String fn, String jsonLiteral) {
        handler.post(() -> web.evaluateJavascript(
                "window." + fn + " && window." + fn + "(" + jsonLiteral + ")", null));
    }

    /** JSON-quote a string so it can ride inside evaluateJavascript. */
    private static String q(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private static class Entry {
        Uri uri;
        String rel;
        String name;
        long size;
    }
}
