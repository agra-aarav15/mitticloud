package in.mitticloud.app;

/**
 * JNI bridge to the embedded Node runtime (nodejs-mobile libnode.so). The
 * native side starts node_start() with the MittiCloud entry script and the
 * environment the server reads: PORT, MITTICLOUD_DATA_DIR, MITTICLOUD_VAULT_DIR.
 */
final class NodeBridge {
    static {
        System.loadLibrary("node");
        System.loadLibrary("mitticloud");
    }

    private NodeBridge() {}

    static native void startNative(String entry, String root, String dataDir, String vaultDir, int port);

    static void start(String entry, String root, String dataDir, String vaultDir, int port) {
        new Thread(() -> startNative(entry, root, dataDir, vaultDir, port), "node-main").start();
    }
}
