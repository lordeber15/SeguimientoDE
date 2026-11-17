# STD — Mapa de base de datos y almacenamiento

> Sistema de Trámite Documentario de **UE 118 / PMESUT** (MINEDU — "Mejoramiento de la Calidad de la Educación Básica y Superior"). App legacy en PHP 7.4, framework MVC propio (no Laravel/CodeIgniter), sobre **MariaDB 10.3.39**. Consultado en este proyecto **solo en modo lectura**.
>
> Fuentes: dump `E:\Eber\STD\dump-stdpmesut_db_pmesut-202610010814.sql` (mysqldump, ~1.66 GB, 5,912,405 líneas, generado 2026-10-01 08:15) y código fuente `E:\Eber\BK STD\STD\std`.
>
> ⚠️ El dump contiene hashes bcrypt de contraseñas (`tbl_usuario`, `admin_users`), remember tokens y datos personales (DNI, RUC, correos, teléfonos, direcciones). Tratarlo como dato sensible.

## 1. Motor y convenciones

- **Servidor:** MariaDB 10.3.39, dump hecho con cliente MariaDB 10.19–11.7.2. Host interno del STD: `192.168.1.16`.
- **Esquema único:** `stdpmesut_db_pmesut`. No hay `CREATE SCHEMA`/`CREATE DATABASE` en el dump.
- **No hay vistas.**
- **Charset:** mayoría `utf8`/`utf8_unicode_ci`; las tablas `admin_*`, `document_category_user`, `tbl_cargo`, `tbl_batch`, `tbl_sede`, `tbl_personal` usan `utf8mb4`.
- **Motores:** mayoría InnoDB (con FK reales). Son **MyISAM** (sin integridad referencial): `tbl_area`, `tbl_configuracion`, `tbl_correlativo`, `tbl_grupo_documento`, `tbl_log`, `tbl_usuario_delegacion`, `tbl_usuario_documento_correlativo`, `tbl_usuario_menu`.
- **Segunda base en el mismo servidor:** `apigproc_database` (sistema externo SISEM), referenciada por ejemplo en `SELECT_BUSCAR_CONTRATO` (`apigproc_database.contract`). No forma parte de este proyecto.
- **Zona horaria:** la app PHP fija la sesión de MySQL a `America/Lima`. Al conectar desde Node/Sequelize conviene fijar `timezone: '-05:00'` y `dateStrings: true` para no desplazar las horas, igual que se hace con el SGD.
- **Rutina y trigger** (definer `clazo@%`):
  - **Trigger `tr_before_documento_mov_insert`** (BEFORE INSERT en `tbl_documento_mov`): si `NEW.plazo` está seteado, calcula `dias_vencimiento = DATEDIFF(plazo, creado)`, `dias_plazo = dias_vencimiento - dias_vencimiento DIV 4`, y fija `NEW.fecha_alerta = NOW() + dias_plazo días`.
  - **`fn_getPersona(ID)` / `fn_getPersona2(ID)`**: devuelven `"<nombre del padre> - <nombre>"`, salvo cuando `id_padre` es `NULL`, `1` o `580` (no se antepone nada).
  - **`fn_replaceSpaces(STR)`**: reemplaza espacios por `&nbsp` (uso de maquetación legacy).
  - **`tamano_archivos_documento(id_documento)`**: suma en MB el tamaño del archivo principal + anexos (`tbl_documento_adjunto`) + adjuntos de todas las derivaciones (`tbl_documento_mov_adjunto`).
  - **Procedimiento `sp_replace_adjunto(old, new)`**: reemplaza `id_adjunto` en `tbl_documento`, `tbl_documento_adjunto` y `tbl_documento_mov_adjunto` (herramienta de mantenimiento, no se usa en consulta).

## 2. Tablas núcleo del trámite documentario

### `tbl_documento` — documento/expediente (61,309 filas, AUTO_INCREMENT 61834)

```sql
CREATE TABLE `tbl_documento` (
  `id_documento` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `nro` int(10) unsigned zerofill NOT NULL DEFAULT 0000000000,  -- siempre 0 en la práctica
  `anio` year(4) DEFAULT NULL,
  `documento` varchar(255) DEFAULT NULL,         -- número del documento, ej. "001-2020-MINEDU/VMGP/UE118-OCP"
  `asunto` text DEFAULT NULL,
  `id_tipo_documento` int(10) unsigned NOT NULL,  -- FK -> tbl_tipo_documento
  `id_origen_documento` int(10) unsigned NOT NULL,-- FK -> tbl_origen_documento
  `etiquetas` varchar(255) DEFAULT NULL,          -- en la práctica, número de contrato (ej. "113-2022-MCEBS")
  `folios` int(11) DEFAULT NULL,
  `fecha` date DEFAULT NULL,
  `observaciones` text DEFAULT NULL,
  `observaciones_old` text DEFAULT NULL,
  `id_usuario` int(10) unsigned NOT NULL,         -- sin FK; quien registró (-> tbl_usuario)
  `id_adjunto` int(10) unsigned DEFAULT NULL,      -- FK -> tbl_adjunto (archivo principal)
  `id_adjunto_old` int(10) unsigned DEFAULT NULL,
  `flg_fisico` tinyint(4) DEFAULT 0,
  `flg_confidencial` tinyint(3) unsigned DEFAULT NULL,
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `id` int(11) DEFAULT NULL,                       -- columna legacy, sin uso claro
  `id_area_usuaria` int(10) unsigned DEFAULT NULL, -- sin FK; -> tbl_area_usuaria
  `id_remitente` int(11) DEFAULT NULL,             -- sin FK; -> tbl_persona (remitente)
  PRIMARY KEY (`id_documento`),
  CONSTRAINT `FK_tbl_documento` FOREIGN KEY (`id_tipo_documento`) REFERENCES `tbl_tipo_documento` (`id_tipo_documento`),
  CONSTRAINT `FK_tbl_documento__id_adjunto` FOREIGN KEY (`id_adjunto`) REFERENCES `tbl_adjunto` (`id_adjunto`),
  CONSTRAINT `FK_tbl_documento__id_origen_documento` FOREIGN KEY (`id_origen_documento`) REFERENCES `tbl_origen_documento` (`id_origen_documento`)
) ENGINE=InnoDB;
```

Fila de ejemplo (la primera, id 1):
```
(1, 0000000000, 2020, '001-2020-MINEDU/VMGP/UE118-OCP',
 'Opinión técnica sobre 2do producto de la Consultoria de Jacqueline Mori',
 3, 2, NULL, NULL, '2020-01-02', NULL, NULL, 0, NULL, NULL, 0, 0,
 '2020-07-10 19:07:25', NULL, NULL, NULL, NULL)
```
Fila reciente (id 61827, el penúltimo):
```
(61827, 0000000000, NULL, 'N°988_02026_SEG_PMESUT-UNALM',
 'Informe Especial sobre Solicitud Conciliatoria ...',
 1, 1, '113-2022-MCEBS', NULL, '2026-05-05',
 'ESTE DOCUMENTO HA LLEGADO POR MESA DE PARTE VIRTUAL', NULL,
 99, 354608, NULL, NULL, NULL, '2026-05-05 21:45:39', '2026-05-05 21:45:39',
 NULL, NULL, 1726)
```

> **Posible corte de uso:** el último `tbl_documento` se creó el 2026-05-05 (id 61833), pero `tbl_documento_mov` y `tbl_adjunto` siguen creciendo hasta 2026-09-30. El menú legacy incluye "Registrar documento en SGD" → `https://sgd.ue118.gob.pe`, así que el registro nuevo probablemente migró a otro sistema y el STD quedó solo para seguimiento de lo ya ingresado.

### `tbl_documento_mov` — movimientos/derivaciones (519,251 filas, AUTO_INCREMENT 519815)

Forma un **árbol** por `id_padre` (cada derivación hija apunta a la derivación de la que proviene).

```sql
CREATE TABLE `tbl_documento_mov` (
  `id_documento_mov` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `id_documento` int(10) unsigned NOT NULL,        -- FK -> tbl_documento (CASCADE)
  `id_origen_padre` int(10) unsigned DEFAULT NULL, -- institución/persona padre del origen (ej. 582=PMESUT)
  `id_origen` int(10) unsigned NOT NULL,           -- FK -> tbl_persona (quien envía)
  `id_area_origen` int(11) DEFAULT NULL,           -- sin FK; -> tbl_area
  `cargo_origen` text DEFAULT NULL,
  `id_destino_padre` int(10) unsigned DEFAULT NULL,
  `id_destino` int(10) unsigned NOT NULL,          -- FK -> tbl_persona (quien recibe)
  `id_area_destino` int(11) DEFAULT NULL,          -- sin FK; -> tbl_area
  `cargo_destino` text DEFAULT NULL,
  `id_estado` int(10) unsigned NOT NULL,           -- FK -> tbl_estado
  `id_accion` int(10) unsigned NOT NULL,           -- FK -> tbl_accion
  `id_padre` int(10) unsigned DEFAULT NULL,        -- self-FK -> tbl_documento_mov (CASCADE); raíz = NULL
  `flg_copia` tinyint(3) unsigned NOT NULL DEFAULT 0,  -- 1 = es copia (69,633 filas)
  `observaciones` text DEFAULT NULL,
  `plazo` date DEFAULT NULL,
  `fecha_alerta` date DEFAULT NULL,                -- calculada por el trigger, ver §1
  `mail_alerta` int(11) DEFAULT 0,
  `fecha_revizado` datetime DEFAULT NULL,          -- se marca al abrir el detalle
  `fecha_atendido` datetime DEFAULT NULL,          -- se marca al derivar/archivar
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `id_documento_old` int(11) DEFAULT NULL,
  PRIMARY KEY (`id_documento_mov`),
  CONSTRAINT `FK_tbl_documento_mov` FOREIGN KEY (`id_accion`) REFERENCES `tbl_accion` (`id_accion`),
  CONSTRAINT `FK_tbl_documento_mov_` FOREIGN KEY (`id_estado`) REFERENCES `tbl_estado` (`id_estado`),
  CONSTRAINT `FK_tbl_documento_mov__id_documento` FOREIGN KEY (`id_documento`) REFERENCES `tbl_documento` (`id_documento`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_tbl_documento_mov__id_documento_mov` FOREIGN KEY (`id_padre`) REFERENCES `tbl_documento_mov` (`id_documento_mov`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_tbl_documento_mov__id_persona_destino` FOREIGN KEY (`id_destino`) REFERENCES `tbl_persona` (`id_persona`),
  CONSTRAINT `FK_tbl_documento_mov__id_persona_origen` FOREIGN KEY (`id_origen`) REFERENCES `tbl_persona` (`id_persona`)
) ENGINE=InnoDB;
```

Fila de ejemplo (id 519807):
```
(519807, 48683, 582, 632, 7, 'Especialista', 580, 1, 16, '', 3, 2, 360512, 0,
 'se atendio con INFORME N° 120-2025-MINEDU/VMGP/UE118/PMESUT-OGI/UEPO-EGP-EGV std 48613',
 NULL, NULL, 0, NULL, NULL, '2026-09-23 06:21:46', '2026-09-23 06:21:46', NULL)
```
Lectura: documento 48683, origen padre 582 (PMESUT), origen persona 632 (área 7), destino persona 1 ("N/D", área 16), estado 3 Archivado, acción 2, derivación padre 360512.

### `tbl_adjunto` — registro de archivos (357,266 filas, ~2.48 TB, AUTO_INCREMENT 357799)

```sql
CREATE TABLE `tbl_adjunto` (
  `id_adjunto` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `adjunto` char(40) DEFAULT NULL,           -- UNIQUE; sha1(nombre_original . microtime()); nombre físico en disco, SIN extensión
  `id_tipo_adjunto` int(10) unsigned NOT NULL, -- FK -> tbl_tipo_adjunto (trae la carpeta base en .ruta)
  `nombre` text DEFAULT NULL,                -- nombre original CON extensión
  `tamano` bigint(20) unsigned NOT NULL DEFAULT 0,  -- bytes
  `hash` char(40) DEFAULT NULL,              -- sha1_file() del CONTENIDO (no único; sirve para deduplicar/verificar)
  `mime` varchar(255) DEFAULT NULL,          -- ej. "application/pdf; charset=binary"
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_exist` int(11) DEFAULT 0,              -- flag de verificación (validationFilesAction)
  PRIMARY KEY (`id_adjunto`),
  UNIQUE KEY `NewIndex1` (`adjunto`),
  CONSTRAINT `FK_tbl_adjunto` FOREIGN KEY (`id_tipo_adjunto`) REFERENCES `tbl_tipo_adjunto` (`id_tipo_adjunto`)
) ENGINE=InnoDB;
```

**No hay columna de ruta ni de extensión aparte.** La ruta se construye con `tbl_tipo_adjunto.ruta` + la regla de sharding (ver §4). La extensión solo existe dentro de `nombre`.

Filas de ejemplo:
```
(5, 'e2a5a0a324ef6c2f757e1de6d412c99e74b668f6', 1, 'RegistroDocumento.csv', 631154,
 'ae05d30c...', 'text/plain; charset=utf-8', '2020-08-07 13:37:27', NULL, 0)

(357796, 'f7e0ad8f8445d7777024abc0d43c9918902cb635', 1,
 '01. Informe N° 000059-2026-MINEDU-VMGPUE118PMESUT-OGI-UEPO-JJRA.pdf', 1213329,
 '601c40c8...', 'application/pdf; charset=binary', '2026-09-30 22:30:35', '2026-09-30 22:30:35', 0)
```
Ruta física del segundo ejemplo (tipo 1, `ruta='uploads/'`):
```
uploads/f7/e0/ad/f7e0ad8f8445d7777024abc0d43c9918902cb635
```

**Estadísticas:**
- Volumen total ≈ **2.48 TB**; archivo más grande ≈ 21 GB; 45 filas con tamaño 0.
- Extensiones (por `nombre`): .pdf 299,942 · .docx 33,633 · .xlsx 11,934 · .zip 5,211 · .7z 976 · .rar 856 · .jpg 760 · .mp4 744 · .doc 561 · algunos .dwg/.heic/.mpp/.tmp.
- **265,781 hashes de contenido distintos**, de los cuales **51,953 se repiten** (mismo archivo subido varias veces con `adjunto` distinto). Deduplicar por `hash`/sha256 del contenido es muy rentable aquí.
- `is_exist`: 343,827 en 0, 13,439 en 1 (el flag casi no se usa/actualiza).
- Subidas por año: 2020 7.3k · 2021 20.8k · 2022 41k · 2023 67k · 2024 79k · 2025 103k · 2026(parcial) 38.7k.

### `tbl_documento_adjunto` — anexos del documento principal (124,754 filas)

```sql
CREATE TABLE `tbl_documento_adjunto` (
  `id_documento_adjunto` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `id_documento` int(10) unsigned NOT NULL,  -- FK -> tbl_documento (CASCADE)
  `id_adjunto` int(10) unsigned NOT NULL,    -- FK -> tbl_adjunto
  `id_adjunto_old` int(10) unsigned DEFAULT NULL,
  `id_documento_old` int(10) unsigned DEFAULT NULL,
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_documento_adjunto`),
  CONSTRAINT `FK_tbl_documento_adjunto` FOREIGN KEY (`id_documento`) REFERENCES `tbl_documento` (`id_documento`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_tbl_documento_adjunto_k` FOREIGN KEY (`id_adjunto`) REFERENCES `tbl_adjunto` (`id_adjunto`)
) ENGINE=InnoDB;
```

### `tbl_documento_mov_adjunto` — archivos de una derivación (170,594 filas)

```sql
CREATE TABLE `tbl_documento_mov_adjunto` (
  `id_documento_mov_adjunto` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `id_documento_mov` int(10) unsigned NOT NULL,  -- FK -> tbl_documento_mov (CASCADE)
  `id_adjunto` int(10) unsigned NOT NULL,        -- FK -> tbl_adjunto (CASCADE)
  `id_adjunto_old` int(10) unsigned DEFAULT NULL,
  `id_documento_mov_old` int(10) unsigned DEFAULT NULL,
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_documento_mov_adjunto`),
  CONSTRAINT `FK_tbl_documento_mov_adjunto` FOREIGN KEY (`id_documento_mov`) REFERENCES `tbl_documento_mov` (`id_documento_mov`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_tbl_documento_mov_adjunto1` FOREIGN KEY (`id_adjunto`) REFERENCES `tbl_adjunto` (`id_adjunto`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
```

### `tbl_documento_referencia` — referencias entre documentos (7,730 filas)

```sql
CREATE TABLE `tbl_documento_referencia` (
  `id_documento_referencia` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `id_documento` int(10) unsigned NOT NULL,       -- FK -> tbl_documento (CASCADE)
  `id_documento_ref` int(10) unsigned DEFAULT NULL, -- FK -> tbl_documento (CASCADE)
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_documento_referencia`)
) ENGINE=InnoDB;
```

### `tbl_documento_task` — tareas/entregables sobre un documento (870 filas, sin FK)

```sql
CREATE TABLE `tbl_documento_task` (
  `id_documento_task` int(11) NOT NULL AUTO_INCREMENT,
  `grupo` varchar(50) DEFAULT NULL,
  `id_grupo` int(11) DEFAULT NULL,
  `id_tarea` int(11) DEFAULT NULL,
  `message` tinytext DEFAULT NULL,
  `state_id` int(11) DEFAULT NULL,
  `status` int(11) DEFAULT 1,
  `id_documento` int(11) DEFAULT NULL,   -- sin FK; -> tbl_documento
  `fecha` date DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `updated_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`id_documento_task`) USING BTREE
) ENGINE=InnoDB;
```

## 3. Personas, usuarios y organización

### `tbl_persona` — remitentes/destinatarios, internos y externos (4,424 filas, AUTO_INCREMENT 4927)

```sql
CREATE TABLE `tbl_persona` (
  `id_persona` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `id_tipo_persona` int(10) unsigned NOT NULL DEFAULT 2,  -- FK -> tbl_tipo_persona
  `id_tipo_documento` int(10) unsigned NOT NULL DEFAULT 11, -- FK -> tbl_tipo_documento (grupo 2: DNI/RUC/...)
  `documento` varchar(40) NOT NULL,          -- número de DNI/RUC; UNIQUE junto con id_tipo_documento
  `dni` varchar(8) DEFAULT NULL,
  `copias` int(11) DEFAULT NULL,
  `nombre` varchar(255) DEFAULT NULL,
  `apaterno` varchar(80) DEFAULT NULL,
  `amaterno` varchar(80) DEFAULT NULL,
  `nombres` varchar(80) DEFAULT NULL,
  `sexo` char(1) DEFAULT NULL,
  `razon_social` text DEFAULT NULL,
  `direccion` text DEFAULT NULL,
  `departamento` varchar(64) DEFAULT NULL,
  `provincia` varchar(64) DEFAULT NULL,
  `distrito` varchar(64) DEFAULT NULL,
  `ubigeo` varchar(8) DEFAULT NULL,
  `id_padre` int(10) unsigned DEFAULT NULL,   -- self-FK (CASCADE); institución/área a la que pertenece
  `telefono1` varchar(80) DEFAULT NULL,
  `telefono2` varchar(80) DEFAULT NULL,
  `correo1` varchar(255) DEFAULT NULL,
  `correo2` varchar(255) DEFAULT NULL,
  `observaciones` text DEFAULT NULL,
  `id_estado` int(10) unsigned NOT NULL DEFAULT 10,  -- FK -> tbl_estado (10 Activo / 11 Inactivo)
  `creado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `modificado` timestamp NULL DEFAULT NULL,
  `revisado` tinyint(4) DEFAULT 0,
  `cargo` varchar(255) DEFAULT NULL,
  `cargo_real` text DEFAULT NULL,
  `id_cargo` int(11) DEFAULT NULL,            -- sin FK; -> tbl_cargo
  `entidad` text DEFAULT NULL,
  `visitas_perfil` int(11) DEFAULT 4,
  `visitas_control` int(11) DEFAULT 0,
  `visitas_visitas` int(11) DEFAULT 0,
  PRIMARY KEY (`id_persona`),
  UNIQUE KEY `idx_tipo_doc__doc` (`id_tipo_documento`,`documento`),
  CONSTRAINT `FK_tbl_persona` FOREIGN KEY (`id_tipo_persona`) REFERENCES `tbl_tipo_persona` (`id_tipo_persona`),
  CONSTRAINT `FK_tbl_persona__id_estado` FOREIGN KEY (`id_estado`) REFERENCES `tbl_estado` (`id_estado`),
  CONSTRAINT `FK_tbl_persona_hija` FOREIGN KEY (`id_padre`) REFERENCES `tbl_persona` (`id_persona`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;
```

- **Persona 582 = PMESUT** (RUC 20552329032), la institución. **580 = "N/D"** (sin dato / destino genérico externo).
- `fn_getPersona(id)` no antepone el nombre del padre cuando `id_padre` es `NULL`, `1` o `580`.
- Ejemplo externo: `(2, 2, 11, '20602806791', NULL, NULL, 'DISTRIBUIDORA Y SERVICIOS S.A.C.', ..., 'JR. ANTONIO DE ELIZALDE NRO 470 ...', 'LIMA','LIMA','LIMA','150101', 580, ...)`.
- Ejemplo interno: persona 4, `id_padre=582`, correo `arios@ue118.gob.pe`, `id_cargo=17`.

### `tbl_usuario` — usuarios de la aplicación (594 filas, AUTO_INCREMENT 673)

```sql
CREATE TABLE `tbl_usuario` (
  `id_usuario` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `usuario` varchar(254) NOT NULL,      -- UNIQUE; es un correo
  `id_persona` int(10) unsigned NOT NULL, -- FK -> tbl_persona
  `clave` varchar(255) DEFAULT NULL,     -- hash bcrypt $2y$
  `claveold` varchar(255) DEFAULT NULL,
  `token` varchar(255) DEFAULT NULL,
  `id_area` int(10) unsigned NOT NULL,   -- sin FK; -> tbl_area
  `id_rol` int(10) unsigned NOT NULL DEFAULT 4,  -- FK -> tbl_rol
  `id_estado` int(10) unsigned NOT NULL, -- FK -> tbl_estado (8 Activo / 9 Inactivo / 12 bloqueado / 13 Reservado)
  `observaciones` text DEFAULT NULL,
  `creado` timestamp NOT NULL DEFAULT current_timestamp(),
  `modificado` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `correo2` varchar(255) DEFAULT NULL,
  `nombre` varchar(255) DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id_usuario`),
  UNIQUE KEY `NewIndex1` (`usuario`),
  CONSTRAINT `FK_tbl_usuario` FOREIGN KEY (`id_estado`) REFERENCES `tbl_estado` (`id_estado`),
  CONSTRAINT `FK_tbl_usuario__id_persona` FOREIGN KEY (`id_persona`) REFERENCES `tbl_persona` (`id_persona`),
  CONSTRAINT `FK_tbl_usuario__id_rol` FOREIGN KEY (`id_rol`) REFERENCES `tbl_rol` (`id_rol`)
) ENGINE=InnoDB;
```
Usuarios internos tienen correo `@ue118.gob.pe`.

### Organización

- **`tbl_area`** (23 filas, MyISAM, sin FK): oficinas/unidades. Columnas: `id_area, id_visitas, area, area_visitas, sigla, sigla_visitas, descripcion (piso), origen (PMESUT/PMESTP/UE118), creado, modificado, id_area_padre, id_visitas_padre, nivel, id_sede, tipo_dependencia`. Jerarquía vía `id_area_padre`/`nivel`. Ver listado completo en §5.
- **`tbl_area_usuaria`** (13 filas): códigos legacy PCM (ej. SGP-PCM, SEGDI-PCM, BID) — remanente del origen PCM/PROMSACE del sistema.
- **`tbl_sede`** (2 filas): 1 SEDE CENTRAL (Calle Los Laureles 399, San Isidro), 2 SUCURSAL (Av. Juan de Arona 752-756, San Isidro).
- **`tbl_cargo`** (138 filas): `id_cargo, cargo (text), creado, modificado`.
- **`tbl_personal`** (166 filas): datos de RR.HH. del personal (contrato, fechas de inicio/fin, contacto de emergencia, sede, área, cargo). Sin FK; columnas documentadas con `COMMENT` en el propio DDL.

## 4. Archivos en disco — reconstrucción de la ruta

### Config de almacenamiento (código fuente, `conf/config.php`)
```php
'uploads' => 'uploads'.DIRECTORY_SEPARATOR,   // ruta relativa a ROOT_PATH
'tmp'     => 'tmp'.DIRECTORY_SEPARATOR,
```
No hay `.env` en la app legacy: todo vive en `conf/config.php`, resuelto contra `ROOT_PATH` (definida en `autoload.php`). En producción, `ROOT_PATH` cae bajo `/home/stdpmesut/...` (ver `include_path` en `conf/config.php`).

### Regla de sharding (`lib/Misc.php`, `Misc::getPath`)
```php
public static function getPath(string $entry, bool $full = false)
{
    return (substr($entry,0,2).DIRECTORY_SEPARATOR.
    substr($entry,2,2).DIRECTORY_SEPARATOR.
    substr($entry,4,2).DIRECTORY_SEPARATOR.($full?$entry:''));
}
```

### Guardado del archivo (`lib/controller/AdjuntoController.php`, `moveFile`)
```php
$hashName = sha1($name . microtime(true));                 // "adjunto": nombre físico, NO recalculable
$basePath = strpos($basePath, "/") == 0 ? $basePath : ROOT_PATH . $basePath;
$path = $basePath . Misc::getPath($hashName, false);        // .../xx/yy/zz/
$finalName = $path . $hashName;                              // .../xx/yy/zz/<hashName>
mkdir($path, 0755, true);
rename($file, $finalName);
$hash = sha1_file($finalName);                                // "hash": del CONTENIDO, sirve para verificar/deduplicar
```

### Regla final (para reconstruir desde SQL/backend)
```
ruta_física = <RAIZ_UPLOADS>/<SUBSTR(adjunto,1,2)>/<SUBSTR(adjunto,3,2)>/<SUBSTR(adjunto,5,2)>/<adjunto>
nombre_descarga = nombre ; content-type = mime ; tamaño = tamano ; integridad = SHA1(archivo) == hash
```
Equivalente SQL (excluyendo SISEM):
```sql
SELECT id_adjunto, nombre, mime, tamano, hash,
  CONCAT('uploads/', SUBSTR(adjunto,1,2),'/',SUBSTR(adjunto,3,2),'/',SUBSTR(adjunto,5,2),'/', adjunto) AS ruta
FROM tbl_adjunto
WHERE id_tipo_adjunto <> 10;
```

### Casos especiales
- **`id_tipo_adjunto = 10` (SISEM, 24 filas):** no hay archivo local. El valor de `adjunto` es el `identifier` de SISEM y el archivo se sirve desde `https://apigproc.pmesut.gob.pe/download/<adjunto>`. **Excluir de cualquier ingesta basada en filesystem.**
- **`id_tipo_adjunto = 11` (Batch, 3 filas):** procesos por lote; revisar antes de ingestar.
- **Dos formatos de MIME:** la ruta de subida "chunked" (la normal, `uploadPartsAction`) usa `finfo` → `"application/pdf; charset=binary"`. Una ruta antigua (`insertarAdjunto1`/`moveUploadedFile`) guarda el tipo MIME tal como lo manda el navegador. Al filtrar por PDF conviene usar `mime LIKE 'application/pdf%' OR LOWER(nombre) LIKE '%.pdf'`, no una igualdad exacta.
- **Sin whitelist de tipo/extensión** en el formulario ni en el servidor: cualquier archivo puede estar ahí.
- **Tope práctico del zip de descarga:** ~1000 MB (el mensaje de error dice 50 MB, pero el límite real en código es 1,048,576,000 bytes). No aplica a la ingesta, que lee archivo por archivo.
- **Columnas `*_old`** en varias tablas (`id_adjunto_old`, `id_documento_old`, etc.) son remanentes de una migración anterior; no confiar en ellas para lógica nueva.

## 5. Catálogos (valores completos)

### `tbl_origen_documento`
| id | origen_documento | descripcion |
|---|---|---|
| 1 | EXTERNO | Documentos Externos |
| 2 | INTERNO | Documentos Internos |
| 3 | SALIENTE | Documentos Salientes |
| 4 | N/D | — |

### `tbl_tipo_documento` (columna `id_grupo_documento`: 1 trámite, 2 identidad, 3 contrato)
| id | tipo_documento | grupo |
|---|---|---|
| 1 | CARTA | 1 |
| 2 | OFICIO | 1 |
| 3 | INFORME | 1 |
| 4 | MEMO MÚLTIPLE | 1 |
| 5 | MEMORANDUM | 1 |
| 6 | OFICIO MÚLTIPLE | 1 |
| 7 | COMPROBANTE PAGO | 1 |
| 8 | OTRO | 1 |
| 9 | SOBRE CERRADO | 1 |
| 10 | DNI | 2 |
| 11 | RUC | 2 |
| 14 | PASAPORTE | 2 |
| 15 | CORREO | 1 |
| 16 | C.E | 2 |
| 17 | OTRO | 2 |
| 18 | INFORME MÚLTIPLE | 1 |
| 19 | CONTRATO | 3 |
| 20 | ORDEN DE SERVICIO | 3 |

### `tbl_estado` (columna `id_grupo_estado`: 2 movimiento, 4 usuario, 5 persona)
| id | estado | grupo |
|---|---|---|
| 0 | Por definir | 2 |
| 1 | Pendiente | 2 |
| 2 | Derivado | 2 |
| 3 | Archivado | 2 |
| 5 | Archivado | 2 |
| 6 | Anulado | 2 |
| 7 | Por respuesta Externa | 2 |
| 8 | Activo | 4 |
| 9 | Inactivo | 4 |
| 10 | Activo | 5 |
| 11 | Inactivo | 5 |
| 12 | bloqueado | 4 |
| 13 | Reservado | 4 |

### `tbl_accion`
| id | accion |
|---|---|
| 1 | Atención en el plazo |
| 2 | Conocimiento y fines |
| 3 | Opinion |
| 4 | Continuar con el trámite |
| 5 | Seguimiento |

### `tbl_tipo_adjunto` (trae `ruta`, la carpeta base del archivo)
| id | tipo_adjunto | ruta | filas en tbl_adjunto |
|---|---|---|---|
| 1 | Adjunto de tramite | `uploads/` | 357,239 |
| 2 | Acta | NULL | — |
| 3 | Adenda | NULL | — |
| 4 | Certificacion | NULL | — |
| 5 | Contrato | NULL | — |
| 6 | Noobj | NULL | — |
| 7 | Solicitud | NULL | — |
| 8 | TDR | NULL | — |
| 10 | SISEM | `/home/apigproc/public_html/storage/app/public/` | 24 (externos, no locales) |
| 11 | Batch | NULL | 3 |

### `tbl_tipo_persona`
1 PERSONA NATURAL · 2 PERSONA JURIDICA

### `tbl_rol`
1 Root · 2 Jefe · 3 Recepcion · 4 Usuario · 5 Direccion · 6 Soporte TI · 8 Asistente

### `tbl_area` (23 oficinas; `id_area_padre` da la jerarquía)
DE Dirección Ejecutiva (1) · OGA Of. Gestión Administrativa (2, bajo DE) · OAL Of. Asesoría Legal (3, bajo DE) · OPPMC Of. Planificación/Presupuesto/Monitoreo (4, bajo DE) · OCP Of. Calidad y Pertinencia (5, bajo DE) · OFGI Of. Fortalecimiento y Gestión IES (6, bajo DE) · OGI Of. Gestión de Infraestructura (7, bajo DE) · UI Unidad de Inversiones (8, bajo OPPMC) · UL Unidad de Logística (9, bajo OGA) · UT Unidad de Tesorería (10, bajo OGA) · UC Unidad de Contabilidad (11, bajo OGA) · UEPO-OGI Unidad de Estudios/Proyectos/Obras (12, bajo OGI) · ECOM Equipo de Comunicaciones (13, bajo USEI) · ETIC Equipo TIC (14, bajo USEI) · UAI Unidad Atención Institutos (15, bajo OFGI) · UAU Unidad Atención Universidades (16, bajo OFGI) · USEI Unidad Soporte Estratégico Institucional (17, bajo DE) · UEPO-OMSE Unidad Estudios/Proyectos/Obras — PMESTP (18, bajo OMSE) · OMSE Of. Mejora de Servicios Educativos — PMESTP (19, bajo DE) · OFSEM Of. Fortalecimiento Servicios Misionales — PMESTP (20, bajo DE) · UF Unidad Formuladora (21, bajo OPPMC) · UMC Unidad Monitoreo Cumplimiento (22, bajo OPPMC) · ECPA Equipo Control Patrimonial y Almacén (23, bajo UL).

### Otras tablas pequeñas sin ejemplos aquí
`tbl_grupo_documento` (1 trámite, 2 identidad), `tbl_grupo_estado` (1 documento, 2 movimiento, 3 contrato, 4 usuario, 5 persona), `tbl_menu`, `tbl_rol_menu`, `tbl_usuario_menu`, `tbl_usuario_delegacion`, `tbl_usuario_documento_correlativo`, `tbl_correlativo`, `tbl_configuracion` (clave `TRAMITE_ID_PERSONA_DESTINO=4652`), `tbl_sesion`, `tbl_log` (4.2M filas, auditoría de requests), `tbl_batch`, `tbl_banner`.

### Módulo de solicitudes de acceso (más nuevo, timestamps camelCase)
`tbl_sistema`, `tbl_solicitud` (tipo ALTA/BAJA/MODIFICACION, con `archivo_sustento` — otra ruta de archivo a revisar aparte si se usa), `tbl_solicitud_sistema`, `tbl_usuario_sistema`, `tbl_estado_solicitud`. No forma parte del flujo de trámite documentario central; evaluar si aporta algo al RAG.

### Tablas `admin_*` (panel tipo laravel-admin)
`admin_config`, `admin_menu`, `admin_operation_log` (vacía), `admin_permissions`, `admin_roles`, `admin_role_menu`, `admin_role_permissions`, `admin_role_users`, `admin_user_permissions`, `admin_users` (bcrypt + remember token). No relevante para el RAG del trámite documentario.

## 6. Consultas canónicas (tomadas literalmente de `lib/MySqlQuery.php`)

### Línea de tiempo de un documento — `SELECT_DOCUMENTO_MOV`
Es la consulta que arma la bandeja de seguimiento de un documento (equivalente a lo que debe hacer `lineaTiempoStd(idDocumento)` en el módulo nuevo). Devuelve además un semáforo de vencimiento calculado en SQL a partir de `plazo`/`fecha_atendido`.
```sql
SELECT
    a.id_documento_mov, a.id_area_origen, a.id_origen, a.cargo_origen,
    a.id_area_destino, a.id_destino, a.cargo_destino, a.id_estado,
    a1.area AS area_remitente, a1.sigla AS sigla_area_remitente, b.nombre AS remitente,
    a2.area AS area_destinatario, a2.sigla AS sigla_area_destinatario, c.nombre AS destinatario,
    d.accion, a.observaciones AS observacion,
    DATE_FORMAT(a.plazo, '%d/%m/%Y') AS plazo,
    e.estado, a.creado,
    IF(a.flg_copia=1,'SI','NO') AS copia
    -- + columnas calculadas "alerta"/"semaforo" a partir de a.plazo, a.fecha_atendido, a.id_estado
FROM tbl_documento_mov a
    JOIN tbl_persona b ON a.id_origen = b.id_persona
    LEFT JOIN tbl_area a1 ON a1.id_area = a.id_area_origen
    JOIN tbl_persona c ON a.id_destino = c.id_persona
    LEFT JOIN tbl_area a2 ON a2.id_area = a.id_area_destino
    JOIN tbl_accion d USING(id_accion)
    JOIN tbl_estado e ON e.id_estado = a.id_estado
WHERE a.id_documento = :id_documento
ORDER BY a.id_documento_mov ASC;
```

### Detalle del documento — `SELECT_DOCUMENTO`
```sql
SELECT a.id_documento, a.documento, b.tipo_documento AS tipoDocumento, a.asunto, a.folios,
       a.etiquetas, a.fecha, a.observaciones, IF(a.flg_fisico=1,'SI','NO') AS flg_fisico,
       a.id_adjunto, a.flg_confidencial
FROM tbl_documento a
    JOIN tbl_tipo_documento b USING(id_tipo_documento)
WHERE a.id_documento = ?;
```

### Archivos de un documento
```sql
-- Archivo principal: tbl_documento.id_adjunto (join directo contra tbl_adjunto)

-- Anexos:
SELECT b.id_adjunto, b.adjunto, b.nombre, b.tamano, b.mime
FROM tbl_documento_adjunto a JOIN tbl_adjunto b USING(id_adjunto)
WHERE a.id_documento = :id_documento;

-- Archivos de una derivación específica:
SELECT b.id_adjunto, b.adjunto, b.nombre, b.tamano, b.mime
FROM tbl_documento_mov_adjunto a JOIN tbl_adjunto b USING(id_adjunto)
WHERE a.id_documento_mov = :id_documento_mov;
```

### Detalle de un adjunto (para descarga/visor) — `SELECT_ADJUNTO`
```sql
SELECT a.id_adjunto, a.adjunto, a.id_tipo_adjunto, a.nombre, a.hash, a.mime,
       a.creado, a.modificado, a.tamano, b.ruta
FROM tbl_adjunto a
    JOIN tbl_tipo_adjunto b USING(id_tipo_adjunto)
WHERE a.id_adjunto = :id_adjunto;
```

### Búsqueda de documento (autocomplete) — `SELECT_BUSCAR_DOCUMENTO`
```sql
SELECT a.id_documento,
       CONCAT("(STD ", a.id_documento, ")  [", c.origen_documento, "] ", b.tipo_documento, "-", a.documento) AS documento
FROM tbl_documento a
    JOIN tbl_tipo_documento b USING(id_tipo_documento)
    JOIN tbl_origen_documento c USING(id_origen_documento)
WHERE CONCAT("[", c.origen_documento, "] ", b.tipo_documento, "-", a.documento, "(", a.id_documento, ")") LIKE :value;
```

### Regla de confidencialidad — tomada de `REPORTE_DOCUMENTOS_CONFIDENCIAL`
Un documento confidencial solo es visible para quien aparece como origen o destino en alguna de sus derivaciones:
```sql
WHERE a.flg_confidencial = 0
   OR a.flg_confidencial IS NULL
   OR (a.flg_confidencial = 1 AND EXISTS (
         SELECT 1 FROM tbl_documento_mov e
         WHERE e.id_documento = a.id_documento AND (e.id_origen = ? OR e.id_destino = ?)
       ));
```
> En el módulo STD del RAG (plan aprobado) se decidió **indexar todo, incluidos los confidenciales**, y restringir el chat/panel STD completo al rol `admin`. Si en el futuro se abre a más roles, replicar esta regla de visibilidad por persona antes de exponer confidenciales.

### Referencias entre documentos
```sql
SELECT a.id_documento_ref, c.tipo_documento, b.documento, b.asunto, u.nombre
FROM tbl_documento_referencia a
    JOIN tbl_documento b ON a.id_documento_ref = b.id_documento
    JOIN tbl_tipo_documento c ON c.id_tipo_documento = b.id_tipo_documento
    JOIN tbl_persona u ON u.id_persona = b.id_remitente
WHERE a.id_documento = :id_documento;
```

### Árbol de movimientos (recorrido, no SQL plano)
`TramiteFlujoController::getMovimientoNodes` arma el árbol recursivamente: raíz = `id_padre IS NULL`, luego hijos con `id_padre = ? AND id_origen = ?`. Útil como referencia si se quiere reconstruir el árbol completo en una sola consulta recursiva (`WITH RECURSIVE`, soportado desde MariaDB 10.2).

## 7. Relación con el proyecto SGD (para el módulo STD del RAG)

- Candidatos para `std.storageService.rutaAdjunto(adjunto)`: validar `adjunto` con `^[0-9a-f]{40}$` antes de construir la ruta (evita path traversal), y excluir siempre `id_tipo_adjunto = 10`.
- Candidatos para el filtro "solo PDF" de la ingesta: `id_tipo_adjunto <> 10 AND tamano > 0 AND (mime LIKE 'application/pdf%' OR LOWER(nombre) LIKE '%.pdf')`.
- Fuente de los tres orígenes de archivo a unir en el barrido: `tbl_documento.id_adjunto` (principal) ∪ `tbl_documento_adjunto` (anexos) ∪ `tbl_documento_mov_adjunto` (derivaciones).
- Watermark de cambios por documento: `GREATEST(MAX(tbl_documento.modificado), MAX(tbl_documento_mov.modificado), MAX(tbl_adjunto.modificado))` agrupado por `id_documento`.
- La deduplicación de ingesta debe apoyarse en el **hash de contenido** (`tbl_adjunto.hash`, o mejor, el sha256 calculado al leer el archivo), no en `adjunto`, dado el alto número de duplicados de contenido (ver §2).
- No existe columna de dependencia/oficina equivalente a `co_dep_emi` del SGD con el mismo significado; `id_area_origen`/`id_area_destino` de `tbl_documento_mov` son lo más cercano, pero sin FK validada contra `tbl_area` en todos los casos.
