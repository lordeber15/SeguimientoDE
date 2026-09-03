import { Router } from 'express';
import { getSesion, postLogin } from '../controllers/authController';
import { requiereAuth } from '../middlewares/authMiddleware';
import { loginRateLimit } from '../middlewares/loginRateLimit';

const router = Router();

router.post('/login', loginRateLimit, postLogin);
router.get('/sesion', requiereAuth, getSesion);

export default router;
