/**
 * Type-safe icon name type for Ionicons
 * Use this instead of `as any` when passing icon names to Ionicons components
 */
import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type IoniconsName = ComponentProps<typeof Ionicons>['name'];
