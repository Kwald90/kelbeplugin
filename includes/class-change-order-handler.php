<?php
/**
 * Change Order Handler
 *
 * Manages change orders
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Change Order Handler class
 */
class KPT_Change_Order_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Change_Order_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Change_Order_Handler
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('wp_ajax_kpt_create_change_order', array($this, 'ajax_create_change_order'));
        add_action('wp_ajax_kpt_update_change_order', array($this, 'ajax_update_change_order'));
        add_action('wp_ajax_kpt_delete_change_order', array($this, 'ajax_delete_change_order'));
        add_action('wp_ajax_kpt_approve_change_order', array($this, 'ajax_approve_change_order'));
        add_action('wp_ajax_kpt_reject_change_order', array($this, 'ajax_reject_change_order'));
    }
    
    /**
     * Get change orders for a project
     *
     * @param int $project_id Project ID
     * @param string $status Optional status filter
     * @return array Change orders
     */
    public function get_change_orders($project_id, $status = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $where = $wpdb->prepare('project_id = %d', $project_id);
        
        if ($status !== null) {
            $where .= $wpdb->prepare(' AND status = %s', $status);
        }
        
        $orders = $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY created_at DESC");
        
        // Enrich with user data
        foreach ($orders as &$order) {
            if ($order->requested_by) {
                $user = get_userdata($order->requested_by);
                if ($user) {
                    $order->requested_by_name = $user->display_name;
                }
            }
            
            if ($order->approved_by) {
                $user = get_userdata($order->approved_by);
                if ($user) {
                    $order->approved_by_name = $user->display_name;
                }
            }
        }
        
        return $orders;
    }
    
    /**
     * Get a single change order
     *
     * @param int $order_id Order ID
     * @return object|null Order object or null
     */
    public function get_change_order($order_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $order_id));
    }
    
    /**
     * Create a change order
     *
     * @param array $data Order data
     * @return int|false Order ID on success, false on failure
     */
    public function create_change_order($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $defaults = array(
            'project_id' => 0,
            'title' => '',
            'description' => '',
            'amount' => 0.00,
            'status' => 'pending',
            'requested_by' => get_current_user_id(),
            'approved_by' => null,
            'approved_at' => null,
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'title' => sanitize_text_field($data['title']),
            'description' => sanitize_textarea_field($data['description']),
            'amount' => floatval($data['amount']),
            'status' => sanitize_text_field($data['status']),
            'requested_by' => absint($data['requested_by']),
            'approved_by' => $data['approved_by'] ? absint($data['approved_by']) : null,
            'created_at' => current_time('mysql'),
            'approved_at' => $data['approved_at'],
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $order_id = $wpdb->insert_id;
        
        do_action('kpt_change_order_created', $order_id, $data);
        
        // Send notification
        $this->send_change_order_notification($order_id, 'created');
        
        return $order_id;
    }
    
    /**
     * Update a change order
     *
     * @param int $order_id Order ID
     * @param array $data Order data
     * @return bool True on success, false on failure
     */
    public function update_change_order($order_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $order = $this->get_change_order($order_id);
        if (!$order) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['title'])) {
            $update_data['title'] = sanitize_text_field($data['title']);
        }
        
        if (isset($data['description'])) {
            $update_data['description'] = sanitize_textarea_field($data['description']);
        }
        
        if (isset($data['amount'])) {
            $update_data['amount'] = floatval($data['amount']);
        }
        
        if (isset($data['status'])) {
            $update_data['status'] = sanitize_text_field($data['status']);
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $order_id));
        
        if ($result !== false) {
            do_action('kpt_change_order_updated', $order_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a change order
     *
     * @param int $order_id Order ID
     * @return bool True on success, false on failure
     */
    public function delete_change_order($order_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $order = $this->get_change_order($order_id);
        if (!$order) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $order_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_change_order_deleted', $order_id, $order);
        }
        
        return $result !== false;
    }
    
    /**
     * Approve a change order
     *
     * @param int $order_id Order ID
     * @param int $user_id User ID
     * @return bool True on success, false on failure
     */
    public function approve_change_order($order_id, $user_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $order = $this->get_change_order($order_id);
        if (!$order) {
            return false;
        }
        
        $update_data = array(
            'status' => 'approved',
            'approved_by' => $user_id,
            'approved_at' => current_time('mysql'),
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $order_id));
        
        if ($result !== false) {
            do_action('kpt_change_order_approved', $order_id, $user_id);
            
            // Update project budget
            $this->update_project_budget($order->project_id, $order->amount);
            
            // Send notification
            $this->send_change_order_notification($order_id, 'approved');
        }
        
        return $result !== false;
    }
    
    /**
     * Reject a change order
     *
     * @param int $order_id Order ID
     * @param int $user_id User ID
     * @return bool True on success, false on failure
     */
    public function reject_change_order($order_id, $user_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $order = $this->get_change_order($order_id);
        if (!$order) {
            return false;
        }
        
        $update_data = array(
            'status' => 'rejected',
            'approved_by' => $user_id,
            'approved_at' => current_time('mysql'),
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $order_id));
        
        if ($result !== false) {
            do_action('kpt_change_order_rejected', $order_id, $user_id);
            
            // Send notification
            $this->send_change_order_notification($order_id, 'rejected');
        }
        
        return $result !== false;
    }
    
    /**
     * Update project budget with change order amount
     *
     * @param int $project_id Project ID
     * @param float $amount Amount to add
     */
    private function update_project_budget($project_id, $amount) {
        $current_budget = get_post_meta($project_id, '_kpt_project_budget', true);
        $current_budget = $current_budget ? floatval($current_budget) : 0;
        
        $new_budget = $current_budget + $amount;
        update_post_meta($project_id, '_kpt_project_budget', $new_budget);
    }
    
    /**
     * Get total change orders amount for project
     *
     * @param int $project_id Project ID
     * @param string $status Optional status filter
     * @return float Total amount
     */
    public function get_total_change_orders($project_id, $status = 'approved') {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_change_orders';
        
        $sql = $wpdb->prepare(
            "SELECT SUM(amount) FROM $table WHERE project_id = %d AND status = %s",
            $project_id,
            $status
        );
        
        $total = $wpdb->get_var($sql);
        
        return $total ? floatval($total) : 0;
    }
    
    /**
     * Send change order notification
     *
     * @param int $order_id Order ID
     * @param string $action Action type (created, approved, rejected)
     */
    private function send_change_order_notification($order_id, $action) {
        $order = $this->get_change_order($order_id);
        if (!$order) {
            return;
        }
        
        $project = get_post($order->project_id);
        if (!$project) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        
        // Notify project owner
        $owner = get_userdata($project->post_author);
        if ($owner) {
            $notification_handler->send_notification(
                $owner->user_email,
                sprintf(__('Change Order %s: %s', 'kelbe-project-tracker'), ucfirst($action), $order->title),
                'change_order_' . $action,
                array(
                    'project_id' => $order->project_id,
                    'project_title' => $project->post_title,
                    'order_id' => $order_id,
                    'order_title' => $order->title,
                    'amount' => $order->amount,
                )
            );
        }
    }
    
    /**
     * AJAX: Create change order
     */
    public function ajax_create_change_order() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_change_orders($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'title' => isset($_POST['title']) ? sanitize_text_field($_POST['title']) : '',
            'description' => isset($_POST['description']) ? sanitize_textarea_field($_POST['description']) : '',
            'amount' => isset($_POST['amount']) ? floatval($_POST['amount']) : 0.00,
        );
        
        $order_id = $this->create_change_order($data);
        
        if ($order_id) {
            wp_send_json_success(array(
                'message' => __('Change order created.', 'kelbe-project-tracker'),
                'order_id' => $order_id,
                'order' => $this->get_change_order($order_id),
            ));
        } else {
            wp_send_json_error(__('Failed to create change order.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update change order
     */
    public function ajax_update_change_order() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $order = $this->get_change_order($order_id);
        
        if (!$order || !$this->user_can_manage_change_orders($order->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['title'])) {
            $data['title'] = sanitize_text_field($_POST['title']);
        }
        
        if (isset($_POST['description'])) {
            $data['description'] = sanitize_textarea_field($_POST['description']);
        }
        
        if (isset($_POST['amount'])) {
            $data['amount'] = floatval($_POST['amount']);
        }
        
        if ($this->update_change_order($order_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Change order updated.', 'kelbe-project-tracker'),
                'order' => $this->get_change_order($order_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update change order.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Delete change order
     */
    public function ajax_delete_change_order() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $order = $this->get_change_order($order_id);
        
        if (!$order || !$this->user_can_manage_change_orders($order->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_change_order($order_id)) {
            wp_send_json_success(__('Change order deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete change order.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Approve change order
     */
    public function ajax_approve_change_order() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $order = $this->get_change_order($order_id);
        
        if (!$order || !$this->user_can_approve_change_orders($order->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->approve_change_order($order_id, $user_id)) {
            wp_send_json_success(array(
                'message' => __('Change order approved.', 'kelbe-project-tracker'),
                'order' => $this->get_change_order($order_id),
            ));
        } else {
            wp_send_json_error(__('Failed to approve change order.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Reject change order
     */
    public function ajax_reject_change_order() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $order = $this->get_change_order($order_id);
        
        if (!$order || !$this->user_can_approve_change_orders($order->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->reject_change_order($order_id, $user_id)) {
            wp_send_json_success(array(
                'message' => __('Change order rejected.', 'kelbe-project-tracker'),
                'order' => $this->get_change_order($order_id),
            ));
        } else {
            wp_send_json_error(__('Failed to reject change order.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * Check if user can manage change orders for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_change_orders($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always manage
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can manage
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        // Team members can manage
        $team_manager = KPT_Team_Manager::get_instance();
        $member = $team_manager->get_team_member($project_id, $user_id);
        
        return (bool) $member;
    }
    
    /**
     * Check if user can approve change orders for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can approve, false otherwise
     */
    private function user_can_approve_change_orders($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always approve
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can approve
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        return false;
    }
}
