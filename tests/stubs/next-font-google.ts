/**
 * Stand-in for `next/font/google` under vitest.
 *
 * next/font is a build-time transform: the real module only exists inside the
 * Next compiler, so importing a page that calls `Bodoni_Moda()` throws
 * "Bodoni_Moda is not a function" in a plain node environment. The SEO tests
 * import page metadata, which is enough to hit it.
 *
 * Named exports, not a Proxy: `import { Bodoni_Moda }` is resolved statically
 * by ESM, so a Proxy on the default export does not satisfy it — which is how
 * the first version of this stub failed.
 *
 * Adding a face to the app means adding one line here.
 */
export type LoadedFont = {
  className: string;
  variable: string;
  style: { fontFamily: string };
};

function stub(name: string) {
  return (): LoadedFont => ({
    className: `stub-${name}`,
    variable: `--font-${name}`,
    style: { fontFamily: name },
  });
}

export const Bodoni_Moda = stub('bodoni-moda');
