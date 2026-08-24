from dataclasses import dataclass
import redis


@dataclass
class OrderJob:
    order_id: str

    def execute(self) -> None:
        print(f"Processing {self.order_id}")


class WorkerController:
    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


def create_worker() -> WorkerController:
    return WorkerController()
