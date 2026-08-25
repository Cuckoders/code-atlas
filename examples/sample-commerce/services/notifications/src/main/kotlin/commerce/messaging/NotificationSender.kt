package commerce.messaging

class NotificationSender {
    fun deliver(orderId: String): Boolean {
        return orderId.isNotBlank()
    };
}
