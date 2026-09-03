/// <reference types="vite/client" />

declare module "*.css";

declare module "*?raw" {
  const content: string;
  export default content;
}
