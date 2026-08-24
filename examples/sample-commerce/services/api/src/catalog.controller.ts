import { ProductRepository } from './models';

export class CatalogController {
  constructor(private readonly products: ProductRepository) {}

  async listProducts() {
    return this.products.findAll();
  }

  async getProduct(id: string) {
    return this.products.findById(id);
  }
}

export function registerCatalogRoutes(app: { get: Function }) {
  app.get('/products', async () => new CatalogController(new ProductRepository()).listProducts());
  app.get('/products/:id', async () => ({ id: 'demo' }));
}
