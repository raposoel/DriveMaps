export const MODULE_ID = "drive-maps";

/* Página-ponte de login (GitHub Pages do projeto). */
export const BRIDGE_URL = "https://raposoel.github.io/DriveMaps/";
export const BRIDGE_ORIGIN = new URL(BRIDGE_URL).origin;

export const PAGE_SIZE = 20;     // módulos por página
export const CONCURRENCY = 8;    // quantos module.json lemos ao mesmo tempo

/* Etapa 2: miniaturas */
export const PIPELINE_VERSION = 1;        // aumente para forçar a releitura dos packs
export const MAX_PACK_BYTES = 150e6;      // packs maiores que isso não são lidos
export const MAX_THUMB_DOWNLOAD = 2e6;    // miniatura pequena: pode baixar o arquivo
export const MAX_BG_DOWNLOAD = 8e6;       // fundo de mapa: só baixa se couber nisso
export const THUMB_WIDTH = 400;

/* Etapa 3: importação */
export const DATA_ROOT = "drive-maps";          // pasta dentro de Data/
export const LARGE_FILE_BYTES = 50e6;           // acima disso, pede confirmação
export const UPLOAD_CONCURRENCY = 2;
export const IMPORT_VERSION = 2;                // muda o nome do cache das cenas quando as regras de importação mudam
