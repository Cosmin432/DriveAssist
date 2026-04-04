# backend/decision.py

def make_decision(detections, traffic_signs=[], env_conditions=[]):
    """
    detections: list of dicts, fiecare dict: {id, class, bbox, estimated_distance, lateral_position}
    traffic_signs: list of strings
    env_conditions: list of strings
    """
    brake = "none"
    lane = "keep"
    speed = "maintain"
    risk = "low"

    # Praguri distanțe (în metri)
    safe_distance = 20
    emergency_distance = 10
    pedestrian_distance_medium = 15
    pedestrian_distance_close = 5
    lateral_distance = 5  # lateral proximity

    # Analiza detectiilor
    for obj in detections:
        cls = obj["class"]
        dist = obj.get("estimated_distance", 100)
        lateral = obj.get("lateral_position", 0)  # -1=stanga, 0=centru, +1=dreapta

        # 🟢 Vehicul în față
        if cls in ["car", "truck"]:
            if dist < emergency_distance:
                brake = "strong"
                speed = "decrease"
                risk = "high"
            elif dist < safe_distance:
                if brake != "strong":
                    brake = "light"
                    speed = "decrease"
                    risk = "medium"

            # Vehicul lateral stânga/dreapta pentru depășire
            if lateral == -1 and dist < lateral_distance:
                lane = "change_right"
                if brake != "strong":
                    brake = "none"
                    speed = "maintain"
                    risk = "medium"
            if lateral == 1 and dist < lateral_distance:
                if brake != "strong":
                    brake = "light"
                    speed = "decrease"
                    lane = "keep"
                    risk = "medium"

        # 🟢 Pietoni / bicicliști
        if cls in ["pedestrian", "person"]:
            if dist < pedestrian_distance_close:
                brake = "strong"
                speed = "decrease"
                risk = "high"
            elif dist < pedestrian_distance_medium:
                if brake != "strong":
                    brake = "light"
                    speed = "decrease"
                    risk = "medium"
        if cls == "bicycle":
            if brake != "strong" and dist < safe_distance:
                brake = "light"
                speed = "decrease"
                risk = "medium"

        # 🟢 Obstacole
        if cls == "obstacle_small":
            if brake != "strong":
                brake = "light"
                speed = "maintain"
                risk = "medium"
        if cls == "obstacle_large":
            brake = "strong"
            speed = "decrease"
            # schimbare banda daca sigur
            lane = "change_left" if lateral >= 0 else "change_right"
            risk = "high"

    # 🟢 Semne de circulație
    for sign in traffic_signs:
        if sign == "stop":
            brake = "strong"
            speed = "decrease"
            lane = "keep"
            risk = "high"
        elif sign == "speed_limit_low":
            if brake != "strong":
                brake = "light"
                speed = "decrease"
                lane = "keep"
                risk = "medium"
        elif sign == "speed_limit_high":
            if brake == "none":
                speed = "increase"
                lane = "keep"
                risk = "low"
        elif sign == "lane_change_left":
            if brake != "strong":
                lane = "change_left"
                speed = "maintain"
                risk = "medium"
        elif sign == "lane_change_right":
            if brake != "strong":
                lane = "change_right"
                speed = "maintain"
                risk = "medium"

    # 🟢 Conditii de mediu
    for cond in env_conditions:
        if cond in ["wet_road", "fog", "low_visibility"]:
            if brake != "strong":
                brake = "light"
                speed = "decrease"
                lane = "keep"
                risk = "medium"

    return {
        "brake": brake,
        "lane": lane,
        "speed": speed,
        "risk": risk
    }