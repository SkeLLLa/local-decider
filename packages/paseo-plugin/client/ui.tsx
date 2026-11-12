import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';

export type Theme = PluginHostProps['theme'];

export function Button({
  label,
  onPress,
  theme,
  disabled = false,
  variant = 'primary',
  grow = false,
  icon,
}: {
  label: string;
  /** Lucide icon name shown before the label, e.g. `RefreshCw`. */
  icon?: string;
  onPress: () => void;
  theme: Theme;
  disabled?: boolean;
  /** `secondary`: outlined, for actions next to content rather than the main call to action. */
  variant?: 'primary' | 'secondary';
  /** Share a row's width equally with sibling buttons. */
  grow?: boolean;
}): ReactNode {
  const primary = variant === 'primary';
  const textColor = primary ? theme.colors.accentForeground : theme.colors.foreground;
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon === undefined ? null : <Icon name={icon} size={14} color={textColor} />}
        <Text numberOfLines={1} style={{ color: textColor, fontSize: 13 }}>
          {label}
        </Text>
      </View>
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

/** Monospace family for paths and commands. */
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export type Tone = 'error' | 'warning' | 'success' | 'info';

function toneColor(theme: Theme, tone: Tone): string {
  if (tone === 'error') {
    return theme.colors.statusDanger;
  }
  if (tone === 'warning') {
    return theme.colors.statusWarning;
  }
  return tone === 'success' ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
}

/** An inline result or error line inside a settings card. */
export function InlineMessage({
  theme,
  tone,
  text,
}: {
  theme: Theme;
  tone: Tone;
  text: string;
}): ReactNode {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: toneColor(theme, tone), fontSize: 13, lineHeight: 18 }}
      >
        {text}
      </Text>
    </View>
  );
}

/** A small outlined label, e.g. `auto: PATH`, `Recommended`, `ok`. */
export function Badge({
  theme,
  text,
  tone = 'info',
}: {
  theme: Theme;
  text: string;
  tone?: Tone;
}): ReactNode {
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone === 'info' ? theme.colors.border : color,
      }}
    >
      <Text style={{ color, fontSize: 11, lineHeight: 16 }}>{text}</Text>
    </View>
  );
}

/** A determinate bar for 0..1, or a spinner when progress is unknown. */
export function Progress({ theme, value }: { theme: Theme; value: number | null }): ReactNode {
  if (value === null) {
    return <ActivityIndicator size="small" color={theme.colors.accent} />;
  }
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={{
        width: 120,
        height: 6,
        flexDirection: 'row',
        borderRadius: 3,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface2,
      }}
    >
      <View style={{ flex: value, backgroundColor: theme.colors.accent }} />
      <View style={{ flex: 1 - value }} />
    </View>
  );
}

/** Small muted monospace text: a path or the exact command behind a button. */
export function Mono({
  theme,
  children,
  lines = 1,
}: {
  theme: Theme;
  children: string;
  lines?: number;
}): ReactNode {
  return (
    <Text
      numberOfLines={lines}
      ellipsizeMode="middle"
      selectable
      style={{
        color: theme.colors.foregroundMuted,
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 16,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * A collapsed-by-default section with a toggle row. The content stays mounted while collapsed
 * (hidden with `display: none`), so form state inside it survives a collapse. Nothing persists.
 */
export function Disclosure({
  theme,
  title,
  children,
}: {
  theme: Theme;
  title: string;
  children: ReactNode;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        style={({ pressed }) => ({
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          gap: 8,
          paddingVertical: 8,
          paddingHorizontal: 4,
          borderRadius: 6,
          backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
        })}
      >
        <Icon
          name={expanded ? 'ChevronDown' : 'ChevronRight'}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{title}</Text>
      </Pressable>
      <View style={{ display: expanded ? 'flex' : 'none', gap: 12 }}>{children}</View>
    </View>
  );
}
