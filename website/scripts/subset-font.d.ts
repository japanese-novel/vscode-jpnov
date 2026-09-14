/** subset-font ships no types; the surface the fonts script uses (README: papandreou/subset-font). */
declare module 'subset-font' {
  interface SubsetOptions {
    readonly targetFormat: 'sfnt' | 'woff' | 'woff2';
    /** Pin a variable axis to one value, or narrow its range. */
    readonly variationAxes?: Readonly<Record<string, number | { readonly min: number; readonly max: number; readonly default?: number }>>;
  }
  export default function subsetFont(buffer: Buffer, text: string, options: SubsetOptions): Promise<Buffer>;
}
