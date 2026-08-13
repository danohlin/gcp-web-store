import { Router } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './cart.controller.js';
import { addItemSchema, itemParamsSchema, updateItemSchema } from './cart.schemas.js';

export const cartRouter = Router();

// Every cart route serves both guests and signed-in users.
cartRouter.use(optionalAuth);

cartRouter.get('/', controller.getCart);
cartRouter.post('/items', validate({ body: addItemSchema }), controller.addItem);
cartRouter.patch(
  '/items/:itemId',
  validate({ params: itemParamsSchema, body: updateItemSchema }),
  controller.updateItem,
);
cartRouter.delete(
  '/items/:itemId',
  validate({ params: itemParamsSchema }),
  controller.removeItem,
);
cartRouter.delete('/', controller.clearCart);
