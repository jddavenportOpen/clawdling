import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Icon({ name, size = 20, color, style }: { name: IconName | string; size?: number; color: string; style?: ComponentProps<typeof Ionicons>['style'] }) {
  return <Ionicons name={name as IconName} size={size} color={color} style={style} accessibilityElementsHidden importantForAccessibility="no" />;
}
