package com.fishtapehq.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * "Send to Fishtape" on Android: files shared from Gmail, Messages, Files, Photos or another app
 * (ACTION_SEND, ACTION_SEND_MULTIPLE, and "Open with" ACTION_VIEW, declared in AndroidManifest.xml)
 * are kept here until the web app takes them; electrical-app/js/lib/files-share.js then opens the Files
 * import sheet and the AI files them. Same JS name and shape as the iOS plugin:
 *
 *     takePending() -> { files: [{ name, mimeType, size, data? (base64), error? }] }
 *     event "filesReceived" {}     more files arrived while the app was open
 *
 * Only content:// and file:// URIs granted to this app are read, once, through the ContentResolver.
 * Files over the per-file limit are reported without data so the web app can say why.
 */
@CapacitorPlugin(name = "FishtapeIncomingFiles")
public class FishtapeIncomingFilesPlugin extends Plugin {
    /** Matches the server's default FILES_MAX_MB (70 MB). */
    static final long MAX_BYTES = 70L * 1024 * 1024;
    static final int MAX_PENDING = 50;

    private final List<Uri> pending = new ArrayList<>();

    @Override
    public void load() {
        collect(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (collect(intent)) notifyListeners("filesReceived", new JSObject(), true);
    }

    /** Remember the files an intent carries. Returns true when there were any. */
    private synchronized boolean collect(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = streamExtra(intent);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.<Uri>getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        }
        boolean any = false;
        for (Uri u : uris) {
            String scheme = u == null ? null : u.getScheme();
            if (!ContentResolver.SCHEME_CONTENT.equals(scheme) && !ContentResolver.SCHEME_FILE.equals(scheme)) continue;
            pending.add(u);
            any = true;
        }
        while (pending.size() > MAX_PENDING) pending.remove(0);
        // Consumed: a configuration change or a later resume must not add the same files again.
        if (any) {
            intent.setAction(Intent.ACTION_MAIN);
            intent.removeExtra(Intent.EXTRA_STREAM);
            intent.setData(null);
        }
        return any;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        return Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
            : (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @PluginMethod
    public void takePending(PluginCall call) {
        final List<Uri> uris;
        synchronized (this) {
            uris = new ArrayList<>(pending);
            pending.clear();
        }
        getBridge().execute(() -> {
            JSArray files = new JSArray();
            ContentResolver cr = getContext().getContentResolver();
            for (Uri uri : uris) files.put(read(cr, uri));
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        });
    }

    private JSObject read(ContentResolver cr, Uri uri) {
        JSObject item = new JSObject();
        String name = "Shared file";
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && c.getString(n) != null) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (Exception ignored) {
            if (uri.getLastPathSegment() != null) name = uri.getLastPathSegment();
        }
        String type = cr.getType(uri);
        item.put("name", name.replaceAll("[\\\\/:\\u0000-\\u001f]", "-"));
        item.put("mimeType", type != null ? type : "application/octet-stream");
        if (size > MAX_BYTES) {
            item.put("size", size);
            item.put("error", "too large (over 70 MB)");
            return item;
        }
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new IllegalStateException("no stream");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            int r;
            while ((r = in.read(buf)) != -1) {
                total += r;
                if (total > MAX_BYTES) {
                    item.put("size", total);
                    item.put("error", "too large (over 70 MB)");
                    return item;
                }
                out.write(buf, 0, r);
            }
            item.put("size", total);
            item.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } catch (Exception e) {
            item.put("error", "unreadable");
        }
        return item;
    }
}
