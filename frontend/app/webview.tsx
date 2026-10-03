import React, { useRef, useState, useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../src/theme/colors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../src/lib/supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://autofill-app-production.up.railway.app';

export default function JobWebViewScreen({ 
  hiddenUrl,
  onProgress
}: { 
  hiddenUrl?: string;
  onProgress?: (msg: string, pct: number) => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ url: string }>();
  const url = hiddenUrl || params.url;
  const webViewRef = useRef<WebView>(null);
  
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Loading job...');
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    AsyncStorage.getItem('@user_profile').then(data => {
      if (data) setProfile(JSON.parse(data));
    });
  }, []);

  const injectExtractionScript = () => {
    const extractScript = `
      (function() {
         try {
           function getLabel(el) {
              let labelText = '';
              if (el.id) {
                  const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                  if (label) labelText = label.innerText.trim();
              }
              if (!labelText) {
                  const parentLabel = el.closest('label');
                  if (parentLabel) labelText = parentLabel.innerText.trim();
              }
              if (!labelText) {
                  const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
                  if (aria) labelText = aria;
              }
              return labelText;
           }

           const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='radio']), select, textarea")).map(el => {
              if (el.offsetParent === null) return null;
              
              let options = [];
              if (el.tagName.toLowerCase() === 'select') {
                  options = Array.from(el.querySelectorAll('option')).map(opt => ({
                      value: opt.value,
                      label: opt.innerText.trim()
                  })).filter(opt => opt.value && opt.label);
              }

              return {
                 id: el.id,
                 name: el.name,
                 type: el.type || el.tagName.toLowerCase(),
                 placeholder: el.placeholder,
                 label: getLabel(el),
                 options: options.length > 0 ? options : undefined
              };
           }).filter(Boolean);
           if (inputs.length === 0) {
               const btns = Array.from(document.querySelectorAll('button, a'));
               const target = btns.find(b => {
                   const txt = b.innerText.toLowerCase().trim();
                   return txt === 'apply now' || txt === 'easy apply' || txt === 'apply';
               });
               if (target && !target.disabled) {
                   target.click();
                   window.ReactNativeWebView.postMessage(JSON.stringify({ type: "CLICKED_APPLY" }));
                   return;
               }
           }

           window.ReactNativeWebView.postMessage(JSON.stringify({ type: "EXTRACTED_FORM", fields: inputs }));
         } catch (e) {
           window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ERROR", message: e.toString() }));
         }
      })();
    `;
    webViewRef.current?.injectJavaScript(extractScript);
  };

  const handleMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      if (data.type === "EXTRACTED_FORM") {
        if (!data.fields || data.fields.length === 0) {
           setStatus('No form fields detected yet.');
           return;
        }

        setStatus('AI is analyzing form...');
        setLoading(true);
        if (onProgress) onProgress('AI is analyzing form...', 40);

        const { data: { session } } = await supabase.auth.getSession();
        
        const response = await fetch(`${API_URL}/jobs/analyze-local`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`
          },
          body: JSON.stringify({
            fields: data.fields,
            profile: profile || {},
            saved_answers: profile?.saved_answers || {},
            job_context: { job_title: "Detected Job", company_name: "Detected Company" }
          })
        });

        const result = await response.json();
        
        if (result.success && result.agent_response && result.agent_response.answers) {
           setStatus('Filling form...');
           if (onProgress) onProgress('Filling form...', 70);
           
           // Build fill script
           const actions = result.agent_response.answers;
           const fillScript = `
             (function() {
                const actions = ${JSON.stringify(actions)};
                actions.forEach(action => {
                    if (action.answer !== null && action.answer !== undefined) {
                        // Find by id or name
                        let el = null;
                        if (action.id) el = document.getElementById(action.id);
                        if (!el && action.name) {
                            const escapedName = CSS.escape(action.name);
                            el = document.querySelector('input[name="' + escapedName + '"]') ||
                                 document.querySelector('select[name="' + escapedName + '"]') ||
                                 document.querySelector('textarea[name="' + escapedName + '"]');
                        }
                        
                        if (el) {
                            el.value = action.answer;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                });
                setTimeout(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const target = btns.find(b => 
                        b.innerText.toLowerCase().includes('next') || 
                        b.innerText.toLowerCase().includes('continue') || 
                        b.innerText.toLowerCase().includes('submit') || 
                        b.innerText.toLowerCase().includes('apply')
                    );
                    if (target && !target.disabled) {
                        target.click();
                    }
                }, 1500);
                
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: "FILL_COMPLETE" }));
             })();
           `;
           
           webViewRef.current?.injectJavaScript(fillScript);
        } else {
           setLoading(false);
           setStatus('AI analysis failed.');
           Alert.alert('Analysis Failed', result.error || 'Unknown error');
        }
      } else if (data.type === "FILL_COMPLETE") {
        setLoading(false);
        setStatus('Form filled! Review and submit manually.');
        if (onProgress) onProgress('Form filled! Proceeding...', 90);
      } else if (data.type === "CLICKED_APPLY") {
        setStatus('Clicking Apply Now...');
        if (onProgress) onProgress('Opening application form...', 30);
      } else if (data.type === "ERROR") {
        console.error("WebView Error:", data.message);
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (hiddenUrl) {
    return (
      <View style={{ width: 0, height: 0, opacity: 0 }}>
        <WebView
          ref={webViewRef}
          source={{ uri: url || 'https://www.indeed.com' }}
          onMessage={handleMessage}
          onLoadEnd={() => {
             if (onProgress) onProgress('Auto-scanning form...', 20);
             setTimeout(injectExtractionScript, 2000);
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: Math.max(insets.top, 20) }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>Assisted Mode</Text>
        <TouchableOpacity 
          style={styles.actionButton}
          onPress={injectExtractionScript}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color={Colors.accent} size="small" /> : <Ionicons name="flash" size={20} color={Colors.accent} />}
          <Text style={[styles.actionText, { color: loading ? '#666' : Colors.accent }]}>AutoFill</Text>
        </TouchableOpacity>
      </View>
      
      {status !== '' && (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: url || 'https://www.indeed.com' }}
        style={styles.webview}
        onMessage={handleMessage}
        onLoadEnd={() => {
           setStatus('Auto-scanning form...');
           setLoading(false);
           setTimeout(injectExtractionScript, 2000);
        }}
        onLoadStart={() => {
           setStatus('Loading page...');
           setLoading(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  backButton: {
    padding: 8,
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  actionText: {
    marginLeft: 4,
    fontWeight: '600',
    fontSize: 14,
  },
  statusBar: {
    backgroundColor: '#111',
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  statusText: {
    color: '#aaa',
    fontSize: 12,
  },
  webview: {
    flex: 1,
    backgroundColor: '#fff',
  }
});
