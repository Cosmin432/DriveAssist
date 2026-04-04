import cv2
import json
import time
from backend.detection import Detector
from backend.decision import make_decision
from server import start_server_background, update_state  # ADD THIS

VIDEO_PATH = "video.mp4"
OUTPUT_JSON = "output.json"

def main():
    detector = Detector(VIDEO_PATH)
    output_data = []

    fps = detector.cap.get(cv2.CAP_PROP_FPS)
    start_time = time.time()

    start_server_background()  # ADD THIS — starts WebSocket on port 8765

    while True:
        frame = detector.get_frame()
        if frame is None:
            break

        dets, traffic_signs = detector.detect_frame(frame)
        env_conditions = detector.get_env_conditions(frame)
        lane_info = detector.detect_lane_info(frame)
        decision = make_decision(dets, traffic_signs=traffic_signs, env_conditions=env_conditions)

        timestamp = time.time() - start_time
        frame_id = detector.frame_id

        json_frame = {
            "timestamp": round(timestamp, 2),
            "frame": frame_id,
            "detections": [
                {
                    "id": d["id"],
                    "class": d["class"],
                    "distance_m": d["estimated_distance"],
                    "position": ("front" if d["lateral_position"]==0 else "left" if d["lateral_position"]==-1 else "right")
                }
                for d in dets
            ],
            "decisions": decision,
            "lane_info": lane_info
        }

        output_data.append(json_frame)
        update_state(json_frame)  # ADD THIS — broadcasts to WebSocket + writes output.json

        print(f"Frame {frame_id} | Decizie:", decision)

        for d in dets:
            x1, y1, x2, y2 = map(int, d["bbox"])
            cls = d["class"]
            conf = d["confidence"]
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0,255,0), 2)
            cv2.putText(frame, f"{cls} {conf:.2f}", (x1, y1-5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,0), 1)

        cv2.putText(frame, f"Brake: {decision['brake']}, Speed: {decision['speed']}, Risk: {decision['risk']}",
                    (10,30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,0,255), 2)

        cv2.imshow("Drive Assist", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    with open(OUTPUT_JSON, "w") as f:
        json.dump(output_data, f, indent=2)

    detector.release()
    cv2.destroyAllWindows()
    print(f"Output salvat in {OUTPUT_JSON}")

if __name__ == "__main__":
    main()