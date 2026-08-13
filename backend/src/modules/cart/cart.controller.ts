import type { Request, RequestHandler, Response } from 'express';
import { CART_COOKIE, setCartCookie } from '../../lib/cookies.js';
import { body, params } from '../../middleware/validate.js';
import * as cartService from './cart.service.js';
import { addItemSchema, itemParamsSchema, updateItemSchema } from './cart.schemas.js';

/**
 * Resolves the active cart for the caller — user-owned when signed in, guest
 * cart keyed by cookie otherwise — issuing and setting a new guest cookie the
 * first time an anonymous visitor touches the cart.
 */
async function currentCartId(req: Request, res: Response): Promise<string> {
  const { cart, issuedSessionToken } = await cartService.resolveCart({
    userId: req.user?.id,
    sessionToken: req.cookies?.[CART_COOKIE],
  });

  if (issuedSessionToken) setCartCookie(res, issuedSessionToken);
  return cart.id;
}

export const getCart: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  res.json(await cartService.getCartView(cartId));
};

export const addItem: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  const { productId, quantity } = body(req, addItemSchema);

  await cartService.addItem(cartId, productId, quantity);
  res.status(201).json(await cartService.getCartView(cartId));
};

export const updateItem: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  const { itemId } = params(req, itemParamsSchema);
  const { quantity } = body(req, updateItemSchema);

  await cartService.updateItem(cartId, itemId, quantity);
  res.json(await cartService.getCartView(cartId));
};

export const removeItem: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  const { itemId } = params(req, itemParamsSchema);

  await cartService.removeItem(cartId, itemId);
  res.json(await cartService.getCartView(cartId));
};

export const clearCart: RequestHandler = async (req, res) => {
  const cartId = await currentCartId(req, res);
  await cartService.clearCart(cartId);
  res.json(await cartService.getCartView(cartId));
};
