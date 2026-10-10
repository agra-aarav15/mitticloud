package in.mitticloud.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
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

        startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mitticloud:server");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        if (!started) {
            started = true;
            startNode();
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
            7333
        );
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        started = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
