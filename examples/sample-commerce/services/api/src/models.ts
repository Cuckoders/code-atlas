export interface Product {
  id: string;
  name: string;
  price: number;
}

export class ProductRepository {
  async findAll(): Promise<Product[]> {
    return [];
  }

  async findById(_id: string): Promise<Product | null> {
    return null;
  }
}
