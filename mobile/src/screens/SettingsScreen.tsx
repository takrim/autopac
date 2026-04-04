import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { signOut } from "../services/auth";
import { useAuth } from "../context/AuthContext";

export default function SettingsScreen() {
  const { user } = useAuth();

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => signOut(),
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{user?.email || "—"}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>User ID</Text>
        <Text style={styles.value}>{user?.uid || "—"}</Text>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>

      <Text style={styles.version}>AutoPac v1.0.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    padding: 20,
  },
  section: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f3460",
  },
  label: {
    color: "#888",
    fontSize: 13,
    marginBottom: 4,
  },
  value: {
    color: "#fff",
    fontSize: 16,
  },
  signOutButton: {
    backgroundColor: "#d9534f",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 24,
  },
  signOutText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  version: {
    color: "#444",
    textAlign: "center",
    marginTop: 40,
    fontSize: 13,
  },
});
