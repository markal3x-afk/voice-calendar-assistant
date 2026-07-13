import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, SafeAreaView, ActivityIndicator, View, Text, Alert, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';

// Default production URL fallback (replace this when deploying to DigitalOcean)
const PRODUCTION_URL = 'https://urchin-app-s2xuq.ondigitalocean.app'; 
const DEV_TUNNEL_URL = 'https://urchin-app-s2xuq.ondigitalocean.app'; // Temp redirect for cloud testing

export default function App() {
  const [hasMicPermission, setHasMicPermission] = useState<boolean | null>(null);
  const [webUrl, setWebUrl] = useState<string>('');
  const webViewRef = useRef<WebView | null>(null);

  // 1. Resolve Backend Server IP Address dynamically
  useEffect(() => {
    // Check if we are running in local development mode or production mode
    if (__DEV__) {
      console.log(`[Expo Go] Development mode active. Target local HTTPS: ${DEV_TUNNEL_URL}`);
      setWebUrl(DEV_TUNNEL_URL);
    } else {
      console.log(`[Production] Target cloud platform: ${PRODUCTION_URL}`);
      setWebUrl(PRODUCTION_URL);
    }
  }, []);

  // 2. Pre-authorize Microphone permissions at the iOS system shell level
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status === 'granted') {
          console.log('[Native Shell] Microphone permission granted.');
          setHasMicPermission(true);
        } else {
          console.warn('[Native Shell] Microphone permission denied.');
          setHasMicPermission(false);
          Alert.alert(
            'Microphone Access Required',
            'Please enable microphone access in your iOS Settings for this app to talk with the scheduling assistant.',
            [{ text: 'OK' }]
          );
        }
      } catch (err) {
        console.error('Failed to request native microphone permission:', err);
        setHasMicPermission(false);
      }
    })();
  }, []);

  if (hasMicPermission === null || !webUrl) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4c5b66" />
        <Text style={styles.loadingText}>Initializing assistant shell...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <WebView
        ref={webViewRef}
        source={{ uri: webUrl }}
        style={styles.webview}
        
        // Critical parameters for low-latency Web Audio streaming & playbacks on iOS
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        onPermissionRequest={(request) => {
          console.log(`[WebView Permission Request] Auto-granting:`, request.resources);
          request.grant();
        }}
        
        // Enable standard browser stores for caching sessions
        domStorageEnabled={true}
        javaScriptEnabled={true}
        
        // Console forwarding bridge
        injectedJavaScript={`
          (function() {
            var origLog = console.log;
            var origError = console.error;
            console.log = function() {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', data: Array.from(arguments).join(' ') }));
              origLog.apply(console, arguments);
            };
            console.error = function() {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', data: Array.from(arguments).join(' ') }));
              origError.apply(console, arguments);
            };
            window.addEventListener('unhandledrejection', function(event) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', data: 'Unhandled Promise Rejection: ' + event.reason }));
            });
          })();
        `}
        onMessage={(event) => {
          try {
            const msg = JSON.parse(event.nativeEvent.data);
            if (msg.type === 'log') {
              console.log(`[WebView Log] ${msg.data}`);
            } else if (msg.type === 'error') {
              console.warn(`[WebView Error] ${msg.data}`);
            }
          } catch(e) {
            console.log('[WebView Native Message]', event.nativeEvent.data);
          }
        }}
        
        // Intercept external link clicks and open them in Safari instead of navigating the WebView away
        onShouldStartLoadWithRequest={(request) => {
          const url = request.url;
          
          // 1. Force Google OAuth redirect trigger to open in native system secure authentication sheet
          // to comply with Google's secure browser policy (prevent disallowed_useragent error)
          if (url.includes('/api/auth/google') && !url.includes('/callback')) {
            console.log(`[WebView Interceptor] Routing Google OAuth link to ASWebAuthenticationSession popup: ${url}`);
            WebBrowser.openAuthSessionAsync(url, 'urchin-app-s2xuq.ondigitalocean.app')
              .then((result) => {
                console.log('[Auth Session] Native popup closed. Result type:', result.type);
                // Reload the WebView so it picks up the newly active credentials
                if (webViewRef.current) {
                  webViewRef.current.reload();
                }
              })
              .catch(err => {
                console.error('Failed to open secure authentication modal:', err);
              });
            return false; // Block it from loading inside the WebView
          }

          // Only intercept manual link clicks (user tapping an anchor tag)
          // This prevents blocking fonts, scripts, stylesheets, or other subresources
          if (request.navigationType !== 'click') {
            return true;
          }

          // Let internal API calls, google login flow, and our server render within the WebView
          const isInternal = 
            url.startsWith(webUrl) || 
            url.includes('localhost') || 
            url.includes('192.168.') ||
            url.includes('accounts.google.com') ||
            url.includes('loca.lt');
            
          if (isInternal) {
            return true; // Allow Webview to load this internally
          }
          
          // Open external links (like event links, searches) in the native browser instead
          console.log(`[WebView Interceptor] Opening external link in iOS browser: ${url}`);
          Linking.openURL(url).catch(err => {
            console.error('Failed to open external link natively:', err);
          });
          return false; // Stop the WebView from loading it
        }}
        
        // Error handling templates
        renderError={(errorDomain, errorCode, errorDesc) => (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>Connection Failed</Text>
            <Text style={styles.errorText}>
              Could not connect to the scheduling gateway server at:{"\n"}
              <Text style={styles.errorUrl}>{webUrl}</Text>
            </Text>
            <Text style={styles.errorHint}>
              Ensure your computer's Express backend is running (npm run dev) and both devices are connected to the same Wi-Fi network.
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fcfbf9', // Matches warm Japanese-minimalism washi background
  },
  webview: {
    flex: 1,
    backgroundColor: '#fcfbf9',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#fcfbf9',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontFamily: 'System',
    fontSize: 14,
    color: '#7a7672', // Slate/gray text
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#fcfbf9',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    textAlign: 'center',
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#c95942', // Hanko Vermilion Red
    marginBottom: 8,
  },
  errorText: {
    fontSize: 14,
    color: '#2a2827',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 12,
  },
  errorUrl: {
    fontWeight: '600',
    color: '#4c5b66',
  },
  errorHint: {
    fontSize: 12,
    color: '#7a7672',
    textAlign: 'center',
    lineHeight: 18,
  },
});
