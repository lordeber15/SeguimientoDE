---
name: std-database
description: Mapa completo de la base de datos del STD (Sistema de Trámite Documentario de UE118/PMESUT) — MariaDB, solo lectura. Úsala al tocar código, migraciones, consultas, ingesta RAG o cualquier integración relacionada con el STD, tbl_documento, tbl_documento_mov, tbl_adjunto, la carpeta uploads/ del STD, o la app legacy en PHP en "E:\Eber\BK STD\STD\std". Evita volver a analizar el dump SQL o el código fuente: toda la estructura ya está documentada en STD_DATABASE.md.
---

# STD Database — índice

Este skill documenta la base de datos del **STD** (Sistema de Trámite Documentario de UE118/PMESUT), un sistema legacy en PHP 7.4 sobre **MariaDB 10.3** (`stdpmesut_db_pmesut`), que el proyecto SGD consulta **solo en modo lectura** para alimentar un RAG independiente.

Fuentes originales (no hace falta volver a leerlas si este documento ya cubre lo necesario):
- Dump de referencia: `E:\Eber\STD\dump-stdpmesut_db_pmesut-202610010814.sql` (mysqldump de MariaDB, ~1.66 GB, generado 2026-10-01).
- Código fuente legacy: `E:\Eber\BK STD\STD\std` (framework PHP propio, sin ORM; toda la SQL vive en `lib/MySqlQuery.php`).

Para el detalle completo —todas las tablas, columnas, FK, catálogos con sus valores, consultas canónicas y la regla de reconstrucción de rutas de archivos— lee **[STD_DATABASE.md](STD_DATABASE.md)** en esta misma carpeta.

## Resumen ultra-rápido

- **Motor:** MariaDB 10.3.39, esquema único `stdpmesut_db_pmesut`, charset `utf8`/`utf8_unicode_ci` (algunas tablas nuevas en `utf8mb4`). Mezcla InnoDB/MyISAM; ver tabla de motores en el documento detallado.
- **Entidad central:** `tbl_documento` (61,309 filas) — un documento/expediente del trámite, con su archivo principal en `id_adjunto`.
- **Flujo:** `tbl_documento_mov` (519,251 filas) — derivaciones persona→persona, formando un árbol por `id_padre`. Estados clave: 1 Pendiente, 2 Derivado, 3/5 Archivado.
- **Archivos:** `tbl_adjunto` (357,266 filas, ~2.48 TB). Todo archivo vive en disco bajo `uploads/<adjunto[0:2]>/<adjunto[2:4]>/<adjunto[4:6]>/<adjunto>`, sin extensión. `adjunto` = `sha1(nombre+microtime)` (no recalculable); `hash` = sha1 del contenido (sirve para verificar integridad y deduplicar). Ver §"Reconstrucción de la ruta de un archivo" en el documento detallado.
- **Confidencialidad:** `tbl_documento.flg_confidencial` — ver la regla de visibilidad exacta en el documento detallado antes de exponer datos del STD.
- **Último documento registrado:** 2026-05-05 (id 61833); después solo hay movimientos. El sistema está en modo casi exclusivamente de consulta.

## Cuándo releer el dump o el código fuente en vez de este documento

- Si necesitas datos reales (no solo estructura) que no están en los ejemplos de este documento.
- Si sospechas que el esquema cambió desde 2026-10-01 (fecha del dump de referencia).
- Si necesitas un detalle de implementación PHP muy específico no cubierto aquí (p. ej. un controlador legacy no documentado).

En esos casos, usa `grep`/`sed -n` sobre el dump (NO lo leas completo: pesa ~1.66 GB y 5.9M de líneas) y sobre `lib/MySqlQuery.php` / `lib/controller/*.php` en el código fuente.
