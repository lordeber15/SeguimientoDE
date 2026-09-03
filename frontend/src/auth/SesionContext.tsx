import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchSesion, type UsuarioSesion } from '../api/auth';
import { cargarTokenGuardado, guardarToken, registrarCierreDeSesion } from '../api/cliente';

interface Sesion {
  usuario: UsuarioSesion | null;
  comprobando: boolean;
  entrar: (usuario: UsuarioSesion) => void;
  salir: () => void;
  puede: (permiso: string) => boolean;
}

const SesionContext = createContext<Sesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<UsuarioSesion | null>(null);
  const [comprobando, setComprobando] = useState(true);

  const salir = useCallback(() => {
    guardarToken(null);
    setUsuario(null);
  }, []);

  // Al recargar la página el token sigue en sessionStorage, pero puede haber caducado o el
  // administrador puede haber retirado el rol: se revalida contra el servidor antes de pintar.
  useEffect(() => {
    if (!cargarTokenGuardado()) {
      setComprobando(false);
      return;
    }

    let vigente = true;
    fetchSesion()
      .then(({ usuario: actual }) => {
        if (vigente) setUsuario(actual);
      })
      .catch(() => {
        if (vigente) salir();
      })
      .finally(() => {
        if (vigente) setComprobando(false);
      });

    return () => {
      vigente = false;
    };
  }, [salir]);

  // Un 401 en cualquier petición cierra la sesión: el token caducó a media tarde y hay que
  // devolver al usuario al login en vez de dejarle una pantalla que falla sin explicación.
  useEffect(() => {
    registrarCierreDeSesion(() => setUsuario(null));
  }, []);

  const valor = useMemo<Sesion>(
    () => ({
      usuario,
      comprobando,
      entrar: setUsuario,
      salir,
      puede: (permiso: string) => Boolean(usuario?.permisos.includes(permiso)),
    }),
    [usuario, comprobando, salir],
  );

  return <SesionContext.Provider value={valor}>{children}</SesionContext.Provider>;
}

export function useSesion(): Sesion {
  const contexto = useContext(SesionContext);
  if (!contexto) throw new Error('useSesion debe usarse dentro de <ProveedorSesion>');
  return contexto;
}
