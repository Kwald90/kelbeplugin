package com.fishtapehq.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins register before the bridge starts (npm plugins register themselves).
        registerPlugin(FishtapeIncomingFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
