/**
 * A compact select: a chip showing the current choice that opens a modal list. Paseo's kit has
 * only full-row selects; chips let one settings row hold a model, its thinking level and mode
 * side by side.
 */
import { Icon, Modal, type ModalProps } from '@getpaseo/plugin/client/ui';
import { useState, type ComponentType, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Theme } from './ui.tsx';

// `ModalComponent` (a FunctionComponent with a static `Content`) does not type-check as a JSX
// element against this package's React types; the runtime component is a plain component.
const Dialog = Modal as unknown as ComponentType<ModalProps>;
const DialogContent = Modal.Content;

export interface ChipOption {
  readonly label: string;
  readonly value: string;
  /** Options with the same group are listed under one heading, in order of first appearance. */
  readonly group?: string;
  /** A muted second line, e.g. a profile's provider, model and thinking level. */
  readonly detail?: string;
}

function groupsOf(options: readonly ChipOption[]): [string, ChipOption[]][] {
  const groups = new Map<string, ChipOption[]>();
  for (const option of options) {
    const key = option.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  return [...groups.entries()];
}

function OptionRow({
  theme,
  option,
  selected,
  onPress,
}: {
  theme: Theme;
  option: ChipOption;
  selected: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={option.label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: selected || pressed ? theme.colors.surface2 : 'transparent',
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{option.label}</Text>
        {option.detail === undefined ? null : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{option.detail}</Text>
        )}
      </View>
      {selected ? <Icon name="Check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

export function ChipPicker({
  theme,
  title,
  value,
  options,
  onChange,
  icon,
  disabled = false,
}: {
  theme: Theme;
  /** Modal title and accessibility label, e.g. "route:fast model". */
  title: string;
  value: string;
  options: readonly ChipOption[];
  onChange: (value: string) => void;
  /** Lucide icon before the chip label, e.g. `Brain` for thinking. */
  icon?: string;
  disabled?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const label = current?.label ?? (value === '' ? 'Choose' : `${value} (not listed)`);
  const muted = current === undefined || value === '';
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${label}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          maxWidth: 260,
          paddingVertical: 5,
          paddingHorizontal: 10,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
          opacity: disabled ? 0.6 : 1,
        })}
      >
        {icon === undefined ? null : (
          <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
        )}
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
            fontSize: 13,
          }}
        >
          {label}
        </Text>
        <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
      <Dialog title={title} open={open} onOpenChange={setOpen}>
        <DialogContent>
          {groupsOf(options).map(([group, items]) => (
            <View key={group} style={{ gap: 2 }}>
              {group === '' ? null : (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    paddingHorizontal: 10,
                    paddingTop: 6,
                  }}
                >
                  {group}
                </Text>
              )}
              {items.map((option) => (
                <OptionRow
                  key={option.value}
                  theme={theme}
                  option={option}
                  selected={option.value === value}
                  onPress={() => {
                    setOpen(false);
                    if (option.value !== value) {
                      onChange(option.value);
                    }
                  }}
                />
              ))}
            </View>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}
