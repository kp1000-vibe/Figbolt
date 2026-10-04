import { ImageResponse } from 'next/og';
import { BrandTile } from '@/lib/brand-mark';

/**
 * The favicon: the same bolt mark the product's own header uses.
 *
 * Generated for the same reason as the OG card — one definition of the mark,
 * no binary asset to forget to update. 32px is what browsers actually render
 * in a tab; the mark is simple enough to survive it.
 */
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<BrandTile size={32} radius={7} glyph={21 / 32} />, size);
}
