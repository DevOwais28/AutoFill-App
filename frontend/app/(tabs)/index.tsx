import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Clipboard,
  ActivityIndicator,
  Image,
  Animated as RNAnimated,
} from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import JobWebViewScreen from '../webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather, Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import Animated, { FadeInUp, FadeInDown, StretchInY } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShareIntent } from 'expo-share-intent';

import { applyToJob, UserProfile, getJobStatus } from '../../src/services/api';

const PROFILE_KEY = '@user_profile';
const ACTIVE_JOBS_KEY = '@active_jobs';

// Progress steps shown in the notification bar
const PROGRESS_STEPS = [
  { pct: 5,  label: 'Connecting to job portal...' },
  { pct: 20, label: 'Reading job form fields...' },
  { pct: 40, label: 'Matching your profile...' },
  { pct: 60, label: 'AI filling in answers...' },
  { pct: 80, label: 'Reviewing form data...' },
  { pct: 95, label: 'Almost done...' },
];

interface ActiveJob {
  thread_id: string;
  url: string;
  title: string;
  status: string;
  timestamp: number;
  data?: string;
}

interface ActiveProcess {
  jobUrl: string;
  progress: number;
  label: string;
}

// Smart cookie lookup: tries all common subdomain permutations for any platform
function findCookiesForUrl(allCookies: Record<string, any[]>, jobUrl: string): any[] | undefined {
  try {
    const urlObj = new URL(jobUrl);
    const hostname = urlObj.hostname;                           // secure.indeed.com
    const baseDomain = hostname.split('.').slice(-2).join('.'); // indeed.com
    const wwwDomain = 'www.' + baseDomain;                     // www.indeed.com
    const wwwHostname = 'www.' + hostname;                      // www.secure.indeed.com

    return (
      allCookies[hostname]   ||
      allCookies[baseDomain] ||
      allCookies[wwwDomain]  ||
      allCookies[wwwHostname]||
      undefined
    );
  } catch {
    return undefined;
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ resumeUrl?: string }>();

  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [activeProcess, setActiveProcess] = useState<ActiveProcess | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);

  const progressAnim = useRef(new RNAnimated.Value(0)).current;
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepIndexRef = useRef(0);

  // ── Share Intent Listener ────────────────────────────────────────────────
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent();

  useEffect(() => {
    const intentValue = (shareIntent as any)?.value || (shareIntent as any)?.text || '';
    if (hasShareIntent && intentValue) {
      // Clean up text if they shared a URL with some text (e.g., from a tweet or a post)
      const urlMatch = intentValue.match(/https?:\/\/[^\s]+/);
      const incomingUrl = urlMatch ? urlMatch[0] : intentValue;
      setUrl(incomingUrl);
      resetShareIntent();
      
      // Automatically trigger apply
      if (incomingUrl && profile) {
        setTimeout(() => handleApply(incomingUrl), 500);
      }
    }
  }, [hasShareIntent, shareIntent, resetShareIntent, profile]);

  // ── Auto-resume after login ──────────────────────────────────────────────
  useEffect(() => {
    if (params.resumeUrl && profile && !loading) {
      setUrl(params.resumeUrl);
      router.setParams({ resumeUrl: '' });
      handleApply(params.resumeUrl);
    }
  }, [params.resumeUrl, profile]);

  // ── Load profile + active jobs on focus ────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem(PROFILE_KEY).then((data) => {
        if (data) { try { setProfile(JSON.parse(data)); } catch {} }
      });
      AsyncStorage.getItem(ACTIVE_JOBS_KEY).then((data) => {
        if (data) {
          try {
            const jobs = JSON.parse(data);
            jobs.sort((a: any, b: any) => b.timestamp - a.timestamp);
            setActiveJobs(jobs);
          } catch {}
        }
      });
    }, [])
  );

  // ── Progress bar animation helpers ─────────────────────────────────────
  const startProgressAnimation = (jobUrl: string, threadId: string) => {
    setActiveProcess({ jobUrl, progress: 0, label: 'Initializing...' });
    progressAnim.setValue(0);

    progressIntervalRef.current = setInterval(async () => {
      try {
        const status = await getJobStatus(threadId);
        if (status && status.progress > 0) {
          setActiveProcess(prev => prev ? { ...prev, progress: status.progress, label: status.label } : prev);
          RNAnimated.timing(progressAnim, {
            toValue: status.progress / 100,
            duration: 800,
            useNativeDriver: false,
          }).start();
        }
      } catch (e) {
        console.log("Status poll error", e);
      }
    }, 2000);
  };

  const finishProgressAnimation = (success: boolean, label: string) => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    const finalPct = success ? 100 : 0;
    setActiveProcess(prev => prev ? { ...prev, progress: finalPct, label } : null);
    RNAnimated.timing(progressAnim, {
      toValue: finalPct / 100,
      duration: 600,
      useNativeDriver: false,
    }).start(() => {
      // Dismiss the in-app bar after a moment
      setTimeout(() => setActiveProcess(null), success ? 3000 : 2000);
    });
  };

  // ── AsyncStorage helpers ────────────────────────────────────────────────
  const saveActiveJob = async (job: ActiveJob) => {
    try {
      const stored = await AsyncStorage.getItem(ACTIVE_JOBS_KEY);
      let jobs: ActiveJob[] = stored ? JSON.parse(stored) : [];
      jobs = jobs.filter(j => j.thread_id !== job.thread_id);
      jobs.push(job);
      await AsyncStorage.setItem(ACTIVE_JOBS_KEY, JSON.stringify(jobs));
      setActiveJobs(jobs.sort((a, b) => b.timestamp - a.timestamp));
    } catch {}
  };

  const removeActiveJob = async (thread_id: string) => {
    try {
      const stored = await AsyncStorage.getItem(ACTIVE_JOBS_KEY);
      let jobs: ActiveJob[] = stored ? JSON.parse(stored) : [];
      jobs = jobs.filter(j => j.thread_id !== thread_id);
      await AsyncStorage.setItem(ACTIVE_JOBS_KEY, JSON.stringify(jobs));
      setActiveJobs(jobs);
    } catch {}
  };

  const handlePaste = async () => {
    try {
      const text = await Clipboard.getString();
      if (text) setUrl(text);
    } catch {}
  };

  const requestPermissions = async () => {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      return status === 'granted';
    }
    return true;
  };

  // ── MAIN APPLY HANDLER ──────────────────────────────────────────────────
  const handleApply = async (overrideUrl?: string | any) => {
    // Guard against React Native passing a GestureResponderEvent
    const jobUrl = typeof overrideUrl === 'string' ? overrideUrl : url;

    if (!jobUrl.trim()) {
      Alert.alert('Missing URL', 'Please paste a valid job application URL.');
      return;
    }
    
    // Basic URL validation
    const lowerUrl = jobUrl.trim().toLowerCase();
    if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://')) {
      Alert.alert('Invalid URL', 'Please ensure the URL starts with http:// or https://');
      return;
    }
    
    if (!profile) {
      Alert.alert(
        'Profile Incomplete',
        'Please complete your candidate profile before applying.',
        [{ text: 'Set Up Profile', onPress: () => router.push('/profile') }, { text: 'Cancel', style: 'cancel' }]
      );
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // NEW ARCHITECTURE: Temporarily open visibly for debugging!
    // Instead of hiding it, we will open the WebView on screen so you can SEE what it's stuck on.
    router.push({ pathname: '/webview', params: { url: jobUrl.trim() } });
    setUrl('');
    return;
    // ────────────────────────────────────────────────────────────────────────
    
    await requestPermissions();
    setLoading(true);
    setUrl('');

    // Load saved session cookies from AsyncStorage
    const cookieData = await AsyncStorage.getItem('universal_cookies');
    const allCookies = cookieData ? JSON.parse(cookieData as string) : {};
    const cookies = findCookiesForUrl(allCookies, jobUrl.trim());

    // Start the in-app progress bar
    const threadId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    startProgressAnimation(jobUrl.trim(), threadId);

    // Post a persistent "in-progress" notification
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '🤖 AI Agent Working...',
        body: 'Filling your job application in the background.',
        data: {},
      },
      trigger: null,
    });

    applyToJob(jobUrl.trim(), profile as any, cookies, threadId)
      .then(async (result) => {
        setLoading(false);

        // ── Login required ────────────────────────────────────────────────
        if (result.requires_login) {
          finishProgressAnimation(false, 'Login required');
          Alert.alert(
            'Login Required',
            'You need to be logged into this portal first.\n\nGo to the Accounts tab → tap the platform → log in → come back and try again.',
            [
              { text: 'Go to Accounts', onPress: () => router.push('/(tabs)/accounts') },
              { text: 'Cancel', style: 'cancel' },
            ]
          );
          return;
        }

        // ── Application failed ────────────────────────────────────────────
        if (!result.success) {
          const errMsg = result.message || result.error || 'Unable to process the application.';
          finishProgressAnimation(false, 'Failed');
          Alert.alert('Application Failed', errMsg);
          await Notifications.scheduleNotificationAsync({
            content: { title: '❌ Application Failed', body: errMsg },
            trigger: null,
          });
          return;
        }

        // ── Success ───────────────────────────────────────────────────────
        finishProgressAnimation(true, '✅ Done! Tap to review.');

        if (result.thread_id) {
          await saveActiveJob({
            thread_id: result.thread_id,
            url: result.url || jobUrl,
            title: result.title || 'Job Application',
            status: 'Ready to Review',
            timestamp: Date.now(),
            data: JSON.stringify(result),
          });
        }

        const answers = result.agent_response?.answers || [];
        const needsInput = answers.filter((a: any) => a.needs_user_input);

        const notifTitle = needsInput.length > 0 ? '⚠️ Your Input Needed' : '✅ Ready to Submit!';
        const notifBody = needsInput.length > 0
          ? `${needsInput.length} field(s) need your answer. Tap to review.`
          : 'Your application is 100% filled. Tap to review and submit!';

        await Notifications.scheduleNotificationAsync({
          content: {
            title: notifTitle,
            body: notifBody,
            data: { route: '/review', params: { data: JSON.stringify(result) } },
          },
          trigger: null,
        });

        // Navigate to review screen
        router.push({ pathname: '/review', params: { data: JSON.stringify(result) } });
      })
      .catch(async (error: any) => {
        setLoading(false);
        const msg = error.friendlyMessage || error.message || 'Failed to connect to the auto-fill service.';
        finishProgressAnimation(false, 'Connection error');
        Alert.alert('Connection Error', msg);
        await Notifications.scheduleNotificationAsync({
          content: { title: '❌ Connection Error', body: msg },
          trigger: null,
        });
      });
  };

  // ── Progress bar width interpolation ───────────────────────────────────
  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  // ────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 60) }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <Animated.View entering={FadeInUp.duration(600).springify()}>
          <View style={styles.headerSection}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Image
                source={require('../../assets/icon.png')}
                style={{ width: 44, height: 44, borderRadius: 12, marginRight: 12 }}
              />
              <View style={styles.badgeContainer}>
                <View style={styles.pulseDot} />
                <Text style={styles.badgeText}>Agent Active</Text>
              </View>
            </View>
            <Text style={styles.title}>ApplyFaster</Text>
            <Text style={styles.subtitle}>Let AI handle the repetitive forms.</Text>
          </View>
        </Animated.View>

        {/* ── In-app progress bar (like video/music notification) ─────────── */}
        {activeProcess && (
          <Animated.View entering={FadeInUp.duration(400).springify()}>
            <View style={styles.progressCard}>
              <View style={styles.progressHeader}>
                <ActivityIndicator size="small" color="#6B46C1" style={{ marginRight: 10 }} />
                <Text style={styles.progressLabel} numberOfLines={1}>{activeProcess.label}</Text>
                <Text style={styles.progressPct}>{activeProcess.progress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <RNAnimated.View style={[styles.progressFill, { width: progressWidth }]} />
              </View>
              <Text style={styles.progressUrl} numberOfLines={1}>{activeProcess.jobUrl}</Text>
            </View>
          </Animated.View>
        )}

        {/* ── URL input ──────────────────────────────────────────────────── */}
        <Animated.View entering={FadeInUp.duration(600).delay(100).springify()}>
          <View style={[styles.card, isUrlFocused && styles.cardFocused]}>
            <Text style={styles.sectionLabel}>Job URL</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.inputField, isUrlFocused && styles.inputFieldActive]}
                value={url}
                onChangeText={setUrl}
                placeholder="https://company.com/careers/..."
                placeholderTextColor="#666666"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onFocus={() => setIsUrlFocused(true)}
                onBlur={() => setIsUrlFocused(false)}
              />
              <TouchableOpacity style={styles.iconButton} onPress={handlePaste} activeOpacity={0.7}>
                <Feather name="clipboard" size={20} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>

        {/* ── Profile missing hint ──────────────────────────────────────── */}
        {!profile && (
          <Animated.View entering={FadeInUp.duration(400).delay(150).springify()}>
            <TouchableOpacity style={styles.hintCard} onPress={() => router.push('/profile')} activeOpacity={0.8}>
              <Ionicons name="person-circle-outline" size={22} color="#FF9500" style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.hintTitle}>Profile not set up</Text>
                <Text style={styles.hintSubtitle}>Tap to complete your profile so AI can fill forms.</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#666" />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ── Active jobs list ──────────────────────────────────────────── */}
        {activeJobs.length > 0 && (
          <Animated.View entering={StretchInY.duration(500)}>
            <View style={styles.activeJobsContainer}>
              <Text style={styles.sectionLabel}>Recent Applications</Text>
              {activeJobs.map((job) => (
                <TouchableOpacity
                  key={job.thread_id}
                  style={styles.activeJobCard}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (job.data) {
                      router.push({ pathname: '/review', params: { data: job.data } });
                    }
                  }}
                >
                  <View style={styles.activeJobInfo}>
                    <Text style={styles.activeJobTitle} numberOfLines={1}>{job.title}</Text>
                    <Text style={styles.activeJobUrl} numberOfLines={1}>{job.url}</Text>
                  </View>
                  <View style={styles.activeJobRight}>
                    <View style={styles.statusBadge}>
                      <Text style={styles.statusText}>{job.status}</Text>
                    </View>
                    <TouchableOpacity onPress={() => removeActiveJob(job.thread_id)} style={styles.deleteButton}>
                      <Feather name="x" size={16} color="#8E8E93" />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </Animated.View>
        )}

        {/* ── Apply button ──────────────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(600).delay(200).springify()}>
          <View style={styles.bottomSection}>
            <TouchableOpacity
              style={[styles.primaryButton, (!url.trim() || loading) && styles.primaryButtonDisabled]}
              onPress={handleApply}
              disabled={!url.trim() || loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator color="#FFFFFF" size="small" />
                  <Text style={styles.primaryButtonText}>Agent Working...</Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>Apply with AI</Text>
              )}
            </TouchableOpacity>
            <Text style={styles.footerNote}>Safe, secure, and fully automated.</Text>
          </View>
        </Animated.View>

        <View style={{ height: Math.max(insets.bottom, 100) }} />
      </ScrollView>
      {backgroundUrl && <JobWebViewScreen hiddenUrl={backgroundUrl} onProgress={(msg, pct) => {
        setActiveProcess(prev => prev ? { ...prev, label: msg, progress: pct } : { label: msg, progress: pct, jobUrl: backgroundUrl });
        RNAnimated.timing(progressAnim, { toValue: pct / 100, duration: 400, useNativeDriver: false }).start();
        
        // Show notification so user can track progress while outside the app (e.g. YouTube)
        Notifications.scheduleNotificationAsync({
           identifier: 'job_progress_notification',
           content: {
              title: 'AutoFill Application',
              body: `${pct}% - ${msg}`,
              sound: false,
           },
           trigger: null,
        });
      }} />}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  scrollView: { flex: 1 },
  content: { paddingHorizontal: 20 },
  headerSection: { marginBottom: 32, marginTop: 20 },
  badgeContainer: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(52, 199, 89, 0.12)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  pulseDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#34C759', marginRight: 6,
  },
  badgeText: { color: '#34C759', fontSize: 12, fontWeight: '600' },
  title: { fontSize: 36, fontWeight: '800', color: '#FFFFFF', letterSpacing: -0.5 },
  subtitle: { fontSize: 16, color: '#8E8E93', marginTop: 6, fontWeight: '400' },

  // Progress card
  progressCard: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#6B46C1',
  },
  progressHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 10,
  },
  progressLabel: { flex: 1, color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  progressPct: { color: '#6B46C1', fontSize: 14, fontWeight: '700' },
  progressTrack: {
    height: 6, backgroundColor: '#2A2A3E', borderRadius: 3, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', borderRadius: 3,
    backgroundColor: '#6B46C1',
  },
  progressUrl: { color: '#666', fontSize: 11, marginTop: 8 },

  // Hint card
  hintCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1A10',
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#3A3010',
  },
  hintTitle: { color: '#FF9500', fontSize: 14, fontWeight: '600' },
  hintSubtitle: { color: '#8E8E93', fontSize: 12, marginTop: 2 },

  // URL card
  card: {
    backgroundColor: '#111111', borderRadius: 18,
    padding: 16, marginBottom: 20,
    borderWidth: 1, borderColor: '#222222',
  },
  cardFocused: { borderColor: '#6B46C1' },
  sectionLabel: { color: '#8E8E93', fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  inputField: { flex: 1, color: '#FFFFFF', fontSize: 15, paddingVertical: 8 },
  inputFieldActive: { color: '#FFFFFF' },
  iconButton: {
    padding: 8, backgroundColor: '#222222', borderRadius: 10, marginLeft: 8,
  },

  // Active jobs
  activeJobsContainer: { marginBottom: 16 },
  activeJobCard: {
    backgroundColor: '#1C1C1E', borderRadius: 14,
    padding: 16, flexDirection: 'row', alignItems: 'center',
    marginBottom: 10, borderWidth: 1, borderColor: '#2C2C2E',
  },
  activeJobInfo: { flex: 1, marginRight: 12 },
  activeJobTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  activeJobUrl: { color: '#8E8E93', fontSize: 13 },
  activeJobRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusBadge: {
    backgroundColor: 'rgba(52,199,89,0.15)',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  statusText: { color: '#34C759', fontSize: 12, fontWeight: '600' },
  deleteButton: { padding: 4 },

  // Bottom / Apply button
  bottomSection: { marginTop: 8 },
  primaryButton: {
    backgroundColor: '#6B46C1', borderRadius: 18,
    paddingVertical: 18, alignItems: 'center', justifyContent: 'center',
  },
  primaryButtonDisabled: { backgroundColor: '#333333', shadowOpacity: 0, elevation: 0 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  footerNote: { marginTop: 16, color: '#666666', fontSize: 12, textAlign: 'center' },
});
