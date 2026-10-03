import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../src/lib/supabase';
import { Colors } from '../src/theme/colors';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { FontAwesome } from '@expo/vector-icons';

// Required to finalize WebBrowser session on Android
WebBrowser.maybeCompleteAuthSession();

export default function AuthScreen() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function signInWithGoogle() {
    try {
      setLoading(true);
      const redirectUrl = Linking.createURL('/(tabs)/');
      
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;
      
      if (data?.url) {
        const res = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);
        if (res.type === 'success') {
          const { url } = res;
          const { error: sessionError } = await supabase.auth.getSessionFromUrl(url);
          if (sessionError) throw sessionError;
          router.back();
        }
      }
    } catch (e: any) {
      Alert.alert("Google Sign-In Failed", e.message || 'An unknown error occurred.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Welcome to AutoFill</Text>
        <Text style={styles.subtitle}>Sign in securely with Google to sync your candidate profile and track your job applications.</Text>

        <TouchableOpacity 
          style={styles.googleButton} 
          onPress={signInWithGoogle} 
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#000" />
          ) : (
            <>
              <FontAwesome name="google" size={20} color="#000" style={styles.googleIcon} />
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>
        
        <Text style={styles.trustText}>
          We only use your email to sync your job applications. No spam, ever.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    justifyContent: 'center',
    padding: 24,
  },
  content: {
    backgroundColor: Colors.bgCard,
    padding: 32,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#aaa',
    marginBottom: 40,
    textAlign: 'center',
    lineHeight: 22,
  },
  googleButton: {
    backgroundColor: '#fff',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  googleIcon: {
    marginRight: 12,
  },
  googleButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
  trustText: {
    marginTop: 24,
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  }
});
