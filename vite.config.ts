import { defineConfig } from 'vite';

// base подставляется в CI: для github.io/<repo>/ нужен префикс,
// для своего домена или user.github.io — оставить '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: {
    // Без явного host Vite на Windows слушает только ::1, и до сервера
    // не достучаться ни браузеру, ни curl.
    host: '127.0.0.1',
    // Порт входит в Origin, а Origin прописан в CORS бакета.
    // Тихий переезд на соседний порт ломает загрузку без внятной причины — лучше упасть.
    port: 5280,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
});
