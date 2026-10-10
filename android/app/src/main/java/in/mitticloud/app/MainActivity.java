package in.mitticloud.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Starts the foreground service, copies the bundled server out of the APK on
 * first run, and shows the dashboard from localhost:7333 in a WebView.
 */
public class MainActivity extends Activity {
    private static final String URL = "http://localhost:7333/";
    private static final String VERSION = "0.16.0";
    private WebView web;
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
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, -1));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
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
        handler.postDelayed(() -> web.loadUrl(URL), 2500);
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
}
