import { useState } from 'react';
import { useSesion } from './auth/SesionContext';
import { AdminUsuariosPage } from './pages/AdminUsuariosPage';
import { CalidadProcesosPage } from './pages/CalidadProcesosPage';
import { ChatPage } from './pages/ChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { DependenciasPage } from './pages/DependenciasPage';
import { LoginPage } from './pages/LoginPage';
import { RagPanelPage } from './pages/RagPanelPage';
import { SeguimientoPage } from './pages/SeguimientoPage';

type Vista = 'seguimiento' | 'dependencias' | 'usuarios' | 'rag' | 'chat' | 'dashboard' | 'calidad';

const VISTAS: Record<Vista, { titulo: string; subtitulo: string; etiqueta: string; permiso: string }> = {
  seguimiento: {
    titulo: 'Seguimiento por usuario',
    subtitulo: 'Expedientes que pasaron por cada usuario y su tiempo de atención',
    etiqueta: 'Seguimiento',
    permiso: 'seguimiento.ver',
  },
  dashboard: {
    titulo: 'Evaluación de desempeño documental',
    subtitulo: 'Productividad y oportunidad por empleado y por oficina',
    etiqueta: 'Dashboard',
    permiso: 'dashboard.ver',
  },
  calidad: {
    titulo: 'Calidad de procesos',
    subtitulo: 'Flujogramas de los procesos detectados, con propuesta de mejora por tiempos',
    etiqueta: 'Calidad de procesos',
    permiso: 'calidad.ver',
  },
  dependencias: {
    titulo: 'Seguimiento de Dependencias',
    subtitulo: 'Dependencias activas y su jefe / responsable asignado',
    etiqueta: 'Dependencias',
    permiso: 'seguimiento.ver',
  },
  usuarios: {
    titulo: 'Usuarios y roles',
    subtitulo: 'Quién entra a este sistema y con qué permisos',
    etiqueta: 'Usuarios',
    permiso: 'usuarios.gestionar',
  },
  rag: {
    titulo: 'Base de conocimientos',
    subtitulo: 'Barrido, conversión y embeddings de los documentos del SGD',
    etiqueta: 'RAG',
    permiso: 'rag.gestionar',
  },
  chat: {
    titulo: 'Chat sobre el SGD',
    subtitulo: 'Preguntas sobre expedientes y documentos, con citas verificables',
    etiqueta: 'Chat',
    permiso: 'rag.consultar',
  },
};

export function App() {
  const { usuario, comprobando, salir, puede } = useSesion();
  const [vista, setVista] = useState<Vista>('seguimiento');
  const [chatExpediente, setChatExpediente] = useState<
    { nuAnnExp: string; nuSecExp: string; numeroExpediente: string } | null
  >(null);

  function abrirChatExpediente(nuAnnExp: string, nuSecExp: string, numeroExpediente: string) {
    setChatExpediente({ nuAnnExp, nuSecExp, numeroExpediente });
    setVista('chat');
  }

  if (comprobando) {
    return (
      <main className="app-main">
        <div className="state-message" role="status">
          Comprobando la sesión…
        </div>
      </main>
    );
  }

  if (!usuario) return <LoginPage />;

  const visibles = (Object.keys(VISTAS) as Vista[]).filter((v) => puede(VISTAS[v].permiso));
  // El permiso puede retirarse mientras la pestaña está abierta: si la vista actual deja de
  // estar permitida, se cae a la primera disponible en vez de intentar pintarla.
  const actualClave = visibles.includes(vista) ? vista : visibles[0];
  const actual = actualClave ? VISTAS[actualClave] : null;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-marca">Seguimiento SGD</div>

        <nav className="app-nav" aria-label="Secciones">
          {visibles.map((clave) => (
            <button
              key={clave}
              type="button"
              className={actualClave === clave ? 'is-activo' : ''}
              aria-current={actualClave === clave ? 'page' : undefined}
              onClick={() => {
                setChatExpediente(null);
                setVista(clave);
              }}
            >
              {VISTAS[clave].etiqueta}
            </button>
          ))}
        </nav>
      </aside>

      <div className="app-contenido">
        <header className="app-header">
          <div className="app-header-texto">
            <h1>{actual?.titulo ?? 'Sin acceso'}</h1>
            <p>{actual?.subtitulo ?? 'Su cuenta no tiene permisos asignados en este sistema.'}</p>
          </div>

          <div className="app-sesion">
            <span className="app-sesion-nombre" title={usuario.roles.join(', ')}>
              {usuario.nombre}
            </span>
            <button type="button" className="app-sesion-salir" onClick={salir}>
              Salir
            </button>
          </div>
        </header>

        {actualClave === 'seguimiento' && (
          <SeguimientoPage
            onAbrirChatExpediente={visibles.includes('chat') ? abrirChatExpediente : undefined}
          />
        )}
        {actualClave === 'dependencias' && <DependenciasPage />}
        {actualClave === 'usuarios' && <AdminUsuariosPage />}
        {actualClave === 'rag' && <RagPanelPage />}
        {actualClave === 'chat' && <ChatPage expedienteInicial={chatExpediente} />}
        {actualClave === 'dashboard' && <DashboardPage />}
        {actualClave === 'calidad' && <CalidadProcesosPage />}
        {!actualClave && (
          <main className="app-main">
            <div className="state-message">
              Su cuenta ha entrado correctamente pero todavía no tiene ningún permiso asignado.
              Solicite al administrador que le asigne un rol.
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
