// Extend File interface to include webkitRelativePath
interface File {
  readonly webkitRelativePath: string;
}

// Extend HTMLInputElement for webkitdirectory
declare global {
  namespace React {
    interface InputHTMLAttributes<T> {
      webkitdirectory?: string;
      directory?: string;
    }
  }
}

export {};