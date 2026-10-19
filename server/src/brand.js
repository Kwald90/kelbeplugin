// The product name comes from electrical-app/js/brand.js (the one place it lives).
let brand = { name: process.env.APP_NAME || 'Fishtape' };
try {
  ({ BRAND: brand } = await import(new URL('../../electrical-app/js/brand.js', import.meta.url).href));
} catch {
  // The API can run without the PWA files next to it (e.g. a slim container).
}
export const BRAND = brand;
