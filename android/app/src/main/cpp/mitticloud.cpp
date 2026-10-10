// JNI shim: starts the embedded Node runtime (nodejs-mobile libnode.so) on the
// bundled MittiCloud server. libnode.so exposes node_init/node_start; this file
// adapts them to the Java NodeBridge.startNative call.
#include <jni.h>
#include <android/log.h>
#include <cstdlib>
#include <string>
#include <vector>

#define LOG_TAG "MittiCloudNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

extern "C" {
// Provided by libnode.so (nodejs-mobile). Declared here so we link against it.
int node_start(int argc, char *argv[]);
}

static std::string jstr(JNIEnv *env, jstring s) {
    if (!s) return "";
    const char *c = env->GetStringUTFChars(s, nullptr);
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}

extern "C" JNIEXPORT void JNICALL
Java_in_mitticloud_app_NodeBridge_startNative(JNIEnv *env, jclass,
                                              jstring entry, jstring root,
                                              jstring dataDir, jstring vaultDir,
                                              jint port) {
    std::string entryPath = jstr(env, entry);
    setenv("PORT", std::to_string(port).c_str(), 1);
    setenv("MITTICLOUD_DATA_DIR", jstr(env, dataDir).c_str(), 1);
    setenv("MITTICLOUD_VAULT_DIR", jstr(env, vaultDir).c_str(), 1);
    chdir(jstr(env, root).c_str());

    std::vector<std::string> args = {"node", entryPath};
    std::vector<char *> argv;
    for (auto &a : args) argv.push_back(&a[0]);
    argv.push_back(nullptr);

    LOGI("starting embedded node on port %d", port);
    int code = node_start(static_cast<int>(args.size()), argv.data());
    LOGI("node exited with code %d", code);
}
