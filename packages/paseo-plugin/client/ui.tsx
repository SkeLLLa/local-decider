import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';

export type Theme = PluginHostProps['theme'];

export function Button({
  label,
  onPress,
  theme,
  disabled = false,
  variant = 'primary',
  grow = false,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  disabled?: boolean;
  /** `secondary`: outlined, for actions next to content rather than the main call to action. */
  variant?: 'primary' | 'secondary';
  /** Share a row's width equally with sibling buttons. */
  grow?: boolean;
}): ReactNode {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        ...(grow ? { flex: 1 } : { alignSelf: 'flex-start' as const }),
        alignItems: 'center' as const,
        paddingVertical: primary ? 8 : 6,
        paddingHorizontal: 14,
        borderRadius: 6,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary
          ? theme.colors.accent
          : pressed
            ? theme.colors.surface2
            : theme.colors.surface1,
        opacity: disabled ? 0.6 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          color: primary ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A screen body: scrolls, pads by layout, and keeps a readable column on wide windows. */
export function Page({
  theme,
  compact,
  children,
}: {
  theme: Theme;
  compact: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        padding: compact ? 16 : 32,
        gap: 24,
      }}
    >
      {children}
    </ScrollView>
  );
}

/** Right-aligned value text for a host `SettingsRow`. */
export function Value({
  theme,
  children,
  muted = false,
}: {
  theme: Theme;
  children: ReactNode;
  muted?: boolean;
}): ReactNode {
  return (
    <Text
      numberOfLines={1}
      style={{
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: 13,
        textAlign: 'right',
        flexShrink: 1,
      }}
    >
      {children}
    </Text>
  );
}
