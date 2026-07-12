import React, { useEffect, useState } from 'react';
import { StyleSheet, SafeAreaView, ActivityIndicator, View, Text, Alert, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';

// Default production URL fallback (replace this when deploying to DigitalOcean)
const PRODUCTION_URL = 'https://urchin-app-s2xuq.ondigitalocean.app'; 
const DEV_TUNNEL_URL = 'https://192.168.1.133:3000'; // Direct Local Secure HTTPS Server

export default function App() {
  const [hasMicPermission, setHasMicPermission] = useState<boolean | null>(null);
  const [webUrl, setWebUrl] = useState<string>('');

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
        source={{ uri: webUrl }}
        style={styles.webview}
        
        // Critical parameters for low-latency Web Audio streaming & playbacks on iOS
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        
        // Enable standard browser stores for caching sessions
        domStorageEnabled={true}
        javaScriptEnabled={true}
        
        // Intercept external link clicks and open them in Safari instead of navigating the WebView away
        onShouldStartLoadWithRequest={(request) => {
          const url = request.url;
          
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
