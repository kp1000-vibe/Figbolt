import { ImageResponse } from 'next/og';
import { BrandTile } from '@/lib/brand-mark';
import { PWA_ICONS, isPwaIconFile } from '@/lib/pwa';

/**
 * The installable-app icons the web manifest points at.
 *
 * An allowlist rather than a size parameter: an endpoint that renders any
 * requested size is an endpoint anyone can ask to render a 20000px PNG.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(PWA_ICONS).map((file) => ({ file }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!isPwaIconFile(file)) return new Response('Not found', { status: 404 });

  const icon = PWA_ICONS[file];
  return new ImageResponse(<BrandTile size={icon.size} radius={icon.radius} glyph={icon.glyph} />, {
    width: icon.size,
    height: icon.size,
  });
}
