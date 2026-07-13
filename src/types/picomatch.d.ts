declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
    nobrace?: boolean;
    nocase?: boolean;
    noext?: boolean;
    noglobstar?: boolean;
  }

  type Matcher = (str: string) => boolean;

  interface Picomatch {
    (pattern: string | string[], options?: PicomatchOptions): Matcher;
    isMatch(str: string, pattern: string | string[], options?: PicomatchOptions): boolean;
  }

  const picomatch: Picomatch;
  export default picomatch;
}
