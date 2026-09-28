import { ImageResponse } from 'next/og';

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
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#3b5bd4',
          borderRadius: 7,
        }}
      >
        <svg width="21" height="21" viewBox="0 0 24 24">
          <path d="M13.5 2.5 6 13.2h4.6L9.8 21.5 18 10.4h-4.9z" fill="#ffffff" />
        </svg>
      </div>
    ),
    size,
  );
}
