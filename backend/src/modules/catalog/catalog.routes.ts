import { Router, type RequestHandler } from 'express';
import { params, query, validate } from '../../middleware/validate.js';
import * as catalogService from './catalog.service.js';
import { productQuerySchema, slugParamsSchema } from './catalog.schemas.js';

const listProducts: RequestHandler = async (req, res) => {
  res.json(await catalogService.listProducts(query(req, productQuerySchema)));
};

const getProduct: RequestHandler = async (req, res) => {
  const { slug } = params(req, slugParamsSchema);
  res.json(await catalogService.getProductBySlug(slug));
};

const listCategories: RequestHandler = async (_req, res) => {
  res.json({ categories: await catalogService.listCategories() });
};

export const catalogRouter = Router();

catalogRouter.get('/products', validate({ query: productQuerySchema }), listProducts);
catalogRouter.get('/products/:slug', validate({ params: slugParamsSchema }), getProduct);
catalogRouter.get('/categories', listCategories);
