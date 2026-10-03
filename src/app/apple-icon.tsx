import { ImageResponse } from 'next/og';
import { BoltMark } from '@/lib/brand-mark';

/**
 * The iOS home-screen icon, used by "Add to Home Screen".
 *
 * Square-cornered on purpose: iOS applies its own rounded mask, and a radius
 * drawn here would show as a second, mismatched corner inside it.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<BoltMark size={180} radius={0} glyph={0.6} />, size);
}
