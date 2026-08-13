import { Router, type Request, type RequestHandler, type Response } from 'express';
import { CART_COOKIE, clearCartCookie, setCartCookie } from '../../lib/cookies.js';
import { optionalAuth } from '../../middleware/auth.js';
import { body, validate } from '../../middleware/validate.js';
import * as cartService from '../cart/cart.service.js';
import * as ordersService from '../orders/orders.service.js';
import * as checkoutService from './checkout.service.js';
import { createOrderSchema } from './checkout.schemas.js';

async function currentCartId(req: Request, res: Response): Promise<string> {
  const { cart, issuedSessionToken } = await cartService.resolveCart({
    userId: req.user?.id,
    sessionToken: req.cookies?.[CART_COOKIE],
  });
  if (issuedSessionToken) setCartCookie(res, issuedSessionToken);
  return cart.id;
}

const quote: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  res.json(await checkoutService.quote(cartId));
};

const createOrder: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  const input = body(req, createOrderSchema);

  const { order } = await checkoutService.createOrder(
    cartId,
    input,
    req.user ? { id: req.user.id, email: req.user.email } : undefined,
  );

  // The guest cart is spent; drop the cookie so the next visit starts fresh.
  if (!req.user) clearCartCookie(res);

  // Returned in full so guests get a confirmation they cannot fetch later.
  res.status(201).json({ order: await ordersService.getById(order.id) });
};

export const checkoutRouter = Router();

checkoutRouter.use(optionalAuth);
checkoutRouter.post('/quote', quote);
checkoutRouter.post('/orders', validate({ body: createOrderSchema }), createOrder);
