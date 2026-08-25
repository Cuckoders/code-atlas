package commerce.notifications

import commerce.messaging.NotificationSender as MessageSender

interface NotificationPort {
    fun send(orderId: String): Boolean;
}

class NotificationController(private val sender: MessageSender) : NotificationPort {
    override fun send(orderId: String): Boolean {
        return sender.deliver(orderId)
    };
}

fun createNotificationController(): NotificationController {
    return NotificationController(MessageSender())
}
