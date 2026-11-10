/**
 * A horizontal slider built from plain views, since Paseo's plugin UI has none. Dragging or
 * pressing the track reports `onChange` continuously and `onCommit` once on release, so a caller
 * can save only the final value.
 */
import { useRef, useState, type ReactNode } from 'react';
import { PanResponder, View, type GestureResponderEvent } from 'react-native';

import type { Theme } from './ui.tsx';

const TRACK_HEIGHT = 4;
const THUMB_SIZE = 16;

export interface SliderZone {
  readonly from: number;
  readonly to: number;
  /** Strong zones use the danger colour, the others the warning colour. */
  readonly strong: boolean;
}

export interface SliderProps {
  theme: Theme;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  zones?: readonly SliderZone[];
  disabled?: boolean;
  width?: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

function snap(x: number, width: number, p: SliderProps): number {
  const ratio = width <= 0 ? 0 : Math.min(1, Math.max(0, x / width));
  const raw = p.min + ratio * (p.max - p.min);
  const stepped = Math.round(raw / p.step) * p.step;
  return Math.round(Math.min(p.max, Math.max(p.min, stepped)) * 100) / 100;
}

function percent(value: number, p: SliderProps): `${number}%` {
  const span = p.max - p.min;
  return `${span <= 0 ? 0 : ((value - p.min) / span) * 100}%`;
}

/** Drag handling; the props and layout are read through refs so the responder is created once. */
function useDrag(props: SliderProps): {
  handlers: ReturnType<typeof PanResponder.create>['panHandlers'];
  setWidth: (width: number) => void;
} {
  const latest = useRef(props);
  latest.current = props;
  const width = useRef(0);
  const start = useRef(0);
  const current = useRef(props.value);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.disabled !== true,
      onMoveShouldSetPanResponder: () => latest.current.disabled !== true,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        start.current = event.nativeEvent.locationX;
        current.current = snap(start.current, width.current, latest.current);
        latest.current.onChange(current.current);
      },
      onPanResponderMove: (_event, gesture) => {
        current.current = snap(start.current + gesture.dx, width.current, latest.current);
        latest.current.onChange(current.current);
      },
      onPanResponderRelease: () => latest.current.onCommit(current.current),
      onPanResponderTerminate: () => latest.current.onCommit(current.current),
    }),
  ).current;
  return {
    handlers: responder.panHandlers,
    setWidth: (w) => {
      width.current = w;
    },
  };
}

function Zones({ theme, props }: { theme: Theme; props: SliderProps }): ReactNode {
  return (props.zones ?? []).map((zone) => (
    <View
      key={`${String(zone.from)}-${String(zone.to)}`}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: percent(zone.from, props),
        width: `${((zone.to - zone.from) / (props.max - props.min)) * 100}%`,
        height: TRACK_HEIGHT,
        borderRadius: TRACK_HEIGHT / 2,
        backgroundColor: zone.strong ? theme.colors.statusDanger : theme.colors.statusWarning,
        opacity: 0.35,
      }}
    />
  ));
}

export function Slider(props: SliderProps): ReactNode {
  const { theme, value, disabled = false, width = 180 } = props;
  const { handlers, setWidth } = useDrag(props);
  const [focused, setFocused] = useState(false);
  const nudge = (direction: 1 | -1): void => {
    const next =
      Math.round(Math.min(props.max, Math.max(props.min, value + direction * props.step)) * 100) /
      100;
    props.onChange(next);
    props.onCommit(next);
  };
  return (
    <View
      {...handlers}
      accessible
      focusable={!disabled}
      accessibilityRole="adjustable"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled }}
      accessibilityValue={{ min: props.min, max: props.max, now: value, text: value.toFixed(2) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        nudge(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        width,
        height: THUMB_SIZE + 8,
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: theme.colors.surface2,
        }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0 }}>
        <Zones theme={theme} props={props} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          width: percent(value, props),
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: theme.colors.accent,
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: percent(value, props),
          marginLeft: -THUMB_SIZE / 2,
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: THUMB_SIZE / 2,
          backgroundColor: theme.colors.foreground,
          borderWidth: focused ? 2 : 0,
          borderColor: theme.colors.accent,
        }}
      />
    </View>
  );
}
