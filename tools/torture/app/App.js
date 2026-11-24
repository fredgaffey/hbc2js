import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import './src/i18n';
import HomeScreen from './src/screens/HomeScreen';
import CoreScreen from './src/screens/CoreScreen';
import JunkScreen from './src/screens/JunkScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { useTortureStore } from './src/store/useTortureStore';
import { loadPersisted } from './src/storage';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function HomeStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Core" component={CoreScreen} />
    </Stack.Navigator>
  );
}

export default function App() {
  const hydrate = useTortureStore((s) => s.hydrate);
  useEffect(() => {
    loadPersisted().then(hydrate);
  }, [hydrate]);
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tabs.Navigator>
          <Tabs.Screen name="HomeTab" component={HomeStack} options={{ headerShown: false, title: 'Home' }} />
          <Tabs.Screen name="Junk" component={JunkScreen} />
          <Tabs.Screen name="Settings" component={SettingsScreen} />
        </Tabs.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
