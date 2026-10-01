import { Router } from 'express';
import { getSesion, postLogin } from '../controllers/authController';
import { requiereAuth } from '../../../compartido/middlewares/authMiddleware';
import { loginRateLimit } from '../../../compartido/middlewares/loginRateLimit';

const router = Router();

router.post('/login', loginRateLimit, postLogin);
router.get('/sesion', requiereAuth, getSesion);

export default router;
