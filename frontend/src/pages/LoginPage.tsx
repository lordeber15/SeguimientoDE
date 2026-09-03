import { useState, type FormEvent } from 'react';
import { login } from '../api/auth';
import { useSesion } from '../auth/SesionContext';

export function LoginPage() {
  const { entrar } = useSesion();
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);

    try {
      entrar(await login(usuario.trim(), clave));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
      setClave('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="login-pantalla">
      <form className="login-caja" onSubmit={enviar}>
        <h1>Seguimiento SGD</h1>
        <p className="login-ayuda">
          Entre con las mismas credenciales que usa en el Sistema de Gestión Documental.
        </p>

        <label htmlFor="login-usuario">Usuario</label>
        <input
          id="login-usuario"
          name="usuario"
          autoComplete="username"
          autoFocus
          required
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
        />

        <label htmlFor="login-clave">Contraseña</label>
        <input
          id="login-clave"
          name="clave"
          type="password"
          autoComplete="current-password"
          required
          value={clave}
          onChange={(e) => setClave(e.target.value)}
        />

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button className="boton-primario login-boton" type="submit" disabled={enviando}>
          {enviando ? 'Comprobando…' : 'Entrar'}
        </button>

        <p className="login-nota">
          Este sistema solo consulta el SGD: su contraseña se valida contra él y nunca se modifica
          nada allí.
        </p>
      </form>
    </main>
  );
}
