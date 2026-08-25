package commerce.inventory;

import java.util.List;

public class InventoryController {
    private final InventoryService inventory = new InventoryService();

    public List<String> listStock() {
        return inventory.listStock();
    }

    public boolean reserve(String productId, int quantity) {
        return inventory.reserve(productId, quantity);
    }
}

class InventoryService {
    public List<String> listStock() {
        return List.of();
    }

    public boolean reserve(String productId, int quantity) {
        return quantity > 0;
    }
}
