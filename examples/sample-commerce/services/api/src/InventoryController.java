package commerce.inventory;

import java.util.List;

public class InventoryController {
    public List<String> listStock() {
        return List.of();
    }

    public boolean reserve(String productId, int quantity) {
        return quantity > 0;
    }
}
