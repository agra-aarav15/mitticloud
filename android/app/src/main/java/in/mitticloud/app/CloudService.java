package in.mitticloud.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import java.io.File;

/**
 * Keeps MittiCloud running 24/7. A foreground service with a partial wake lock
 * and a persistent notification. The embedded Node runtime (libnode) runs the
 * MittiCloud server in this process; the WebView talks to it on localhost:7333.
 */
public class CloudService extends Service {
    public static final String ACTION_STOP = "in.mitticloud.app.STOP";
    private static final String CHANNEL_ID = "mitticloud-server";
    private static final int NOTIFICATION_ID = 7333;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private static volatile boolean started = false;

    public static boolean isRunning() {
        return started;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
    }

    private final android.os.Handler batteryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable batteryTick = new Runnable() {
        @Override
        public void run() {
            writeBattery();
            batteryHandler.postDelayed(this, 30000);
        }
    };

    /** Write the phone's real battery to data/battery.json, read by the server. */
    private void writeBattery() {
        try {
            android.content.Intent s = registerReceiver(null,
                new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (s == null) return;
            int level = s.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
            int scale = s.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100);
            int status = s.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1);
            int plugged = s.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0);
            int tempTenth = s.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            boolean present = s.getBooleanExtra(android.os.BatteryManager.EXTRA_PRESENT, true);
            boolean charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                || status == android.os.BatteryManager.BATTERY_STATUS_FULL
                || plugged != 0;
            int percent = scale > 0 && level >= 0 ? Math.round(level * 100f / scale) : -1;
            String temp = tempTenth == Integer.MIN_VALUE ? "null" : String.valueOf(tempTenth / 10.0);
            String json = "{\"level\":" + percent + ",\"charging\":" + charging
                + ",\"temperature\":" + temp + ",\"mocked\":false,\"present\":" + present + "}";
            File data = new File(new File(getFilesDir(), "mitti"), "data");
            data.mkdirs();
            java.nio.file.Files.write(new File(data, "battery.json").toPath(),
                json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            /* no battery reading this tick; the server keeps the last good value */
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, CloudService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(
            this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notice_running))
            .setOngoing(true)
            .setContentIntent(openPi)
            .addAction(0, getString(R.string.action_stop), stopPi)
            .build();

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mitticloud:server");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        // A PARTIAL_WAKE_LOCK keeps the CPU running, but the Wi-Fi radio still
        // powers down when the screen sleeps: after a few idle minutes the SSH
        // session and the cloudflared tunnel drop. A Wi-Fi lock holds the radio
        // up for as long as the server runs. Every call is guarded, so a platform
        // that refuses the lock can never take the server down with it.
        if (wifiLock == null) {
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= 29
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "mitticloud:wifi");
                    wifiLock.setReferenceCounted(false);
                }
            } catch (Exception ignored) {
                /* no Wi-Fi lock available here — keep serving anyway */
            }
        }
        if (wifiLock != null && !wifiLock.isHeld()) {
            try {
                wifiLock.acquire();
            } catch (Exception ignored) {
                /* refused this time — the server still runs */
            }
        }

        if (!started) {
            started = true;
            startNode();
            batteryHandler.removeCallbacks(batteryTick);
            batteryHandler.post(batteryTick);
        }
        return START_STICKY;
    }

    /** Start the embedded Node runtime on the bundled MittiCloud server. */
    private void startNode() {
        File root = new File(getFilesDir(), "mitti");
        File data = new File(root, "data");
        File vault = new File(root, "vault");
        data.mkdirs();
        vault.mkdirs();
        NodeBridge.start(
            new File(root, "server/index.js").getAbsolutePath(),
            root.getAbsolutePath(),
            data.getAbsolutePath(),
            vault.getAbsolutePath(),
            getApplicationInfo().nativeLibraryDir,
            7333
        );
    }

    @Override
    public void onDestroy() {
        batteryHandler.removeCallbacks(batteryTick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) {
            try {
                wifiLock.release();
            } catch (Exception ignored) {
                /* already released */
            }
        }
        started = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
