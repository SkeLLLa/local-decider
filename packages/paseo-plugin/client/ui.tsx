import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export type Theme = PluginHostProps['theme'];

export function Field({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: Theme;
}): ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, width: 90 }}>{label}</Text>
      <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{value}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  theme,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  disabled?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text style={{ color: theme.colors.accentForeground }}>{label}</Text>
    </Pressable>
  );
}
