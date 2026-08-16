// Configuración global compartida entre todos los scripts
// Cargar este archivo ANTES de los demás scripts en cada HTML
window.LK_CONFIG = {
  SUPABASE_URL: "https://nkhzocgdpwtgrmwleihr.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH",
  // Segunda DB vinculada (sync de PIN por CUIT)
  LOEKEMEYER_SUPABASE_URL: "https://kwkclwhmoygunqmlegrg.supabase.co",
  LOEKEMEYER_SUPABASE_ANON_KEY: "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML",
  // Incrementar cuando se actualicen imágenes para invalidar cache
  IMG_VERSION: "9999-12-31-2",
};
